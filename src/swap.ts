import {
    ContractLink, AMMRouter, AMMFactory, AMMRouterHop,
    AMMRouterPair, AMMExchange, ExchangeSettings, ExchangeFee,
    Token, TokenAmount, customToken, getTokenId, SecretJS
} from 'siennajs'
import BigNumber from 'bignumber.js'

import { Market, Loan } from './liquidator'
import {
    normalize_denom, decrease_by_percent,
    clamp, percentage_diff
} from './math'
import * as Tx from './tx'
import { Storage, PoolInfo } from './storage'

const TX_RETRY_COUNT: number = 3

type SwapRoute = ContractLink | AMMRouterHop[]

export interface Liquidation {
    loan: Loan,
    payable: Payable
}

export interface Payable {
    input_amount: BigNumber
    output_amount: BigNumber
    price_impact: number
    route: SwapRoute | undefined
}

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

    async liquidate(storage: Storage, liquidation: Liquidation) {
        const { candidate, market } = liquidation.loan
        const payable = liquidation.payable

        const amount = payable.input_amount.minus(1).decimalPlaces(0, BigNumber.ROUND_DOWN)

        let liquidate_amount: string

        if(payable.route) {
            let resp: SecretJS.TxResponse

            if (route_is_pair(payable.route)) {
                const pair = new AMMExchange(storage.client, payable.route.address, payable.route.code_hash)

                resp = await Tx.retry(
                    () => pair.swap(
                        new TokenAmount(
                            customToken(this.token.address, this.token.code_hash),
                            amount.toString(),
                        ),
                        payable.output_amount.toFixed(0, BigNumber.ROUND_DOWN)
                    ),
                    TX_RETRY_COUNT
                ) as SecretJS.TxResponse
            } else {
                const router = new AMMRouter(
                    storage.client,
                    storage.config.router.address,
                    storage.config.router.code_hash
                )
                
                const route = payable.route // Appeasing TS...
                resp = await Tx.retry(
                    () => router.swap(
                        route,
                        amount.toString(),
                        payable.output_amount.toFixed(0, BigNumber.ROUND_DOWN)
                    ),
                    TX_RETRY_COUNT
                ) as SecretJS.TxResponse
            }

            Tx.assert_resp_ok(resp)

            const swap_amount = new BigNumber(Tx.get_value(resp, 'return_amount')!)
            liquidate_amount = clamp(swap_amount, candidate.payable).toString()
        } else {
            liquidate_amount = amount.toString()
        }

        const resp = await Tx.retry(() => {
                return market.contract.liquidate(
                    liquidate_amount,
                    candidate.id,
                    candidate.market_info.contract.address,
                    market.underlying.address
                )   
            },
            TX_RETRY_COUNT
        ) as SecretJS.TxResponse

        Tx.assert_resp_ok(resp)
        
        const repaid_amount = normalize_denom(new BigNumber(liquidate_amount), market.decimals)
        console.info(`Successfully liquidated a loan by repaying ${repaid_amount.toString()} ${market.symbol} and seized ~$${candidate.seizable_usd} worth of ${candidate.market_info.symbol} (transfered to market: ${candidate.market_info.contract.address})!`)
        console.info(`TX hash: ${resp.transactionHash}`)

        await storage.update_user_balance()
    }

    async payable(
        storage: Storage,
        { candidate, market }: Loan
    ): Promise<Payable> {
        if (market.underlying.address === this.token.address) {
            const amount = clamp(storage.user_balance, candidate.payable)

            return {
                input_amount: amount,
                output_amount: amount,
                price_impact: 0,
                route: undefined
            }
        }

        const key = this.token.address + market.underlying.address
        const route = this.routes.get(key)

        if (!route)
            throw new Error(`Swap route with key ${key} not found.`)

        const pools = (from: Token, info: PoolInfo) => {
            if (getTokenId(info.pair.token_0) === getTokenId(from)) {
                return { offer: info.amount_0, ask: info.amount_1 }
            }

            return { offer: info.amount_1, ask: info.amount_0 }
        }

        const decimals = await storage.decimals_cache.get_many([this.token, market.underlying])

        let balance = normalize_denom(storage.user_balance, decimals[0])
        const payable = normalize_denom(candidate.payable, decimals[1])

        let balance_usd = balance.multipliedBy(storage.prices[storage.config.token.symbol])
        const payable_usd = payable.multipliedBy(storage.prices[market.symbol])

        // Add a 10 USD buffer, otherwise the difference is insignificatnt
        if (balance_usd.gt(payable_usd.plus(10))) {
            const diff = percentage_diff(balance_usd, payable_usd)

            // Decrease based on the percentage difference of the liquidatable price vs user balance
            // We do this so that we don't have to swap more than we need to
            if (diff > 0) {
                balance = balance.minus(decrease_by_percent(balance, diff, 100))
                balance_usd = balance.multipliedBy(storage.prices[storage.config.token.symbol])
            }
        }

        let output_amount: BigNumber

        if (route_is_pair(route)) {
            const info = await storage.pool_cache.get(route)
            const { offer, ask } = pools(customToken(route.address, route.code_hash), info)

            output_amount = this.compute_swap(offer, ask, balance)
        } else {
            output_amount = balance

            const infos = await Promise.all(
                route.map(x => storage.pool_cache.get({
                    address: x.pair_address,
                    code_hash: x.pair_code_hash
                }))
            )

            for (const [i, swap] of route.entries()) {
                const info = infos[i]

                const { offer, ask } = pools(swap.from_token, info)
                output_amount = this.compute_swap(offer, ask, output_amount)
            }
        }

        return {
            input_amount: balance,
            output_amount,
            price_impact: percentage_diff(
                balance_usd,
                output_amount.multipliedBy(storage.prices[market.symbol])
            ),
            route
        }
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
    return decrease_by_percent(amount, fee.nom, fee.denom)
}

function route_is_pair(route: any): route is ContractLink {
    return route.address &&
        typeof route.address === 'string' &&
        typeof route.code_hash === 'string'
}
