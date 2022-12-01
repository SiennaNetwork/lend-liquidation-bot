import {
    ContractLink, AMMRouter, AMMFactory, AMMRouterHop,
    AMMRouterPair, ExchangeSettings, ExchangeFee, Token,
    customToken, getTokenId
} from "siennajs"
import BigNumber from 'bignumber.js'

import { Market, Loan } from './liquidator'
import { retry, normalize_denom, raw_denom, percentage_decrease } from './utils'
import { Storage, PoolInfo } from './storage'

type SwapRoute = ContractLink | AMMRouterHop[]

export class LiquidationsManager {
    static async init(
        router: AMMRouter,
        factory: AMMFactory,
        markets: Market[],
        token_info: ContractLink
    ): Promise<LiquidationsManager> {
        const routes: Map<string, SwapRoute> = new Map()

        const fee_request = factory.getExchangeSettings()

        const all_pairs = await factory.listExchanges(30)
        const pairs = all_pairs.map((x) => new AMMRouterPair(
            x.pair.token_0,
            x.pair.token_1,
            x.contract.address,
            x.contract.code_hash
        ))
    
        const token = customToken(token_info.address, token_info.code_hash)

        for (const market of markets) {
            if (market.underlying.address === token_info.address)
                continue

            const has_route = [false, false]
            const underlying = customToken(market.underlying.address, market.underlying.code_hash)

            for (const pair of pairs) {
                let direct_route = false

                if (pair.contains(token)) {
                    has_route[0] = true
                    direct_route = true
                }

                if (pair.contains(underlying)) {
                    has_route[1] = true
    
                    if (direct_route) {
                        const info = { 
                            address: pair.pair_address,
                            code_hash: pair.pair_code_hash
                        }
    
                        routes.set(token_info.address + market.underlying.address, info)

                        break
                    }
                }
    
                if (has_route.every((x) => x === true)) {
                    routes.set(
                        token_info.address + market.underlying.address,
                        router.assemble(pairs, token, underlying)
                    )

                    routes.set(
                        market.underlying.address + token_info.address,
                        router.assemble(pairs, underlying, token)
                    )

                    break
                }
            }
        }

        return new this(token_info, routes, await fee_request)
    }

    private constructor(
        private token: ContractLink,
        private routes: Map<string, SwapRoute>,
        private fees: ExchangeSettings
    ) { }

    async liquidate({ candidate, market }: Loan) {
        const amount = candidate.payable.decimalPlaces(0, BigNumber.ROUND_DOWN)

        const result: any = await retry(() => {
                return market.contract.liquidate(
                    amount.toString(),
                    candidate.id,
                    candidate.market_info.contract.address
                )   
            },
            3
        )

        const repaid_amount = normalize_denom(amount, market.decimals)
        console.info(`Successfully liquidated a loan by repaying ${repaid_amount.toString()} ${market.symbol} and seized ~$${candidate.seizable_usd} worth of ${candidate.market_info.symbol} (transfered to market: ${candidate.market_info.contract.address})!`)
        console.info(`TX hash: ${result.transactionHash}`)
    }

    async payable(
        storage: Storage,
        { candidate, market }: Loan,
        user_balance: BigNumber
    ): Promise<BigNumber> {
        if (market.underlying.address === this.token.address) {
            return user_balance
        }

        const key = this.token.address + market.underlying.address
        const route = this.routes.get(key)

        const pools = (from: Token, info: PoolInfo) => {
            if (getTokenId(info.pair.token_0) === getTokenId(from)) {
                return { offer: info.amount_0, ask: info.amount_1 }
            }

            return { offer: info.amount_1, ask: info.amount_0 }
        }

        if (!route)
            throw new Error(`Swap route with key ${key} not found.`)
        else if (route_is_pair(route)) {
            const [info, ...decimals] = await Promise.all([
                storage.pool_cache.get(route),
                storage.decimals_cache.get(this.token),
                storage.decimals_cache.get(route)
            ])
            const { offer, ask } = pools(customToken(route.address, route.code_hash), info)

            const balance = normalize_denom(user_balance, decimals[0])
            const payable = normalize_denom(candidate.payable, decimals[1])
            
            const amount = this.compute_offer_amount(offer, ask, payable)

            if (amount > balance) {
                return raw_denom(this.compute_swap(offer, ask, balance), 2)
            }

            return raw_denom(amount, decimals[0])
        } else {
            let amount = new BigNumber(0)

            const infos = await Promise.all(
                route.map(x => storage.pool_cache.get({
                    address: x.pair_address,
                    code_hash: x.pair_code_hash
                }))
            )

            for (const [i, swap] of route.entries()) {
                const info = infos[i]

                const { offer, ask } = pools(swap.from_token, info)
                const result = this.compute_offer_amount(offer, ask, candidate.payable)
            }

            return amount
        }
    }

    private compute_offer_amount(
        offer_pool: BigNumber,
        ask_pool: BigNumber,
        ask_amount: BigNumber
    ): BigNumber {
        const cp = offer_pool.multipliedBy(ask_pool)
    
        let offer_amount = cp.dividedBy(ask_pool.minus(ask_amount)).minus(offer_pool)
        //const spread_amount = offer_amount.multipliedBy(ask_pool.dividedBy(offer_pool)).minus(ask_amount)
    
        // Could do this with a single call, but keeping it like this in
        // order to stay closer to the actual calculations in the contract
        const swap_commission = apply_fee(offer_amount, this.fees.swap_fee)
        const sienna_commission = apply_fee(offer_amount, this.fees.sienna_fee)
    
        const total_commission = swap_commission.plus(sienna_commission)
    
        offer_amount = offer_amount.plus(total_commission)

        return offer_amount
    }

    private compute_swap(
        offer_pool: BigNumber,
        ask_pool: BigNumber,
        offer_amount: BigNumber
    ): BigNumber {
        // https://github.com/SiennaNetwork/sienna/blob/2f75175212278c289ea27270cf20cbdfb62a4b90/contracts/exchange/src/contract.rs#L637-L644
    
        // Could do this with a single call, but keeping it like this in
        // order to stay closer to the actual calculations in the contract
        const swap_commission = apply_fee(offer_amount, this.fees.swap_fee)
        const sienna_commission = apply_fee(offer_amount, this.fees.sienna_fee)
    
        // https://github.com/SiennaNetwork/sienna/blob/2f75175212278c289ea27270cf20cbdfb62a4b90/contracts/exchange/src/contract.rs#L661-L662
        const total_commission = swap_commission.plus(sienna_commission)
        offer_amount = offer_amount.minus(total_commission)
    
        // https://github.com/SiennaNetwork/sienna/blob/2f75175212278c289ea27270cf20cbdfb62a4b90/contracts/exchange/src/contract.rs#L673-L694
        const total_pool = offer_pool.multipliedBy(ask_pool)
        const return_amount = ask_pool.minus(total_pool.dividedBy(offer_pool.plus(offer_amount)))
    
        // spread = offer_amount * ask_pool / offer_pool - return_amount
        //const spread_amount = offer_amount
        //    .multipliedBy(ask_pool.dividedBy(offer_pool))
        //    .minus(return_amount)
    
        return return_amount
    }
}

function apply_fee(amount: BigNumber, fee: ExchangeFee) {
    return percentage_decrease(amount, fee.nom, fee.denom)
}

function route_is_pair(route: any): route is ContractLink {
    return route.address &&
        typeof route.address === 'string' &&
        typeof route.code_hash === 'string'
}
