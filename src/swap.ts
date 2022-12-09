import {
    ContractLink, AMMRouter, AMMFactory, AMMRouterHop, LendAuth,
    AMMRouterPair, AMMExchange, ExchangeSettings, ExchangeFee,
    Token, TokenAmount, LendMarket, LendOverseerMarket,
    customToken, getTokenId, SecretJS
} from 'siennajs'
import BigNumber from 'bignumber.js'

import { Market, Loan } from './liquidator'
import {
    normalize_denom, decrease_by_percent,
    clamp, percentage_diff
} from './math'
import * as Tx from './tx'
import { Storage, PoolInfo } from './storage'
import { SecretJsSigner } from './secretjs_signer'

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
        let index = 0

        while (index < markets.length) {
            const market = markets[index]

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

            if (has_route.some((x) => x === false)){
                const [removed] = markets.splice(index, 1)
                console.info(`Couldn't find a swap route for the ${removed.symbol} market (${removed.contract.address}) and will not perform liquidations on it.`)
            }
            else
                index++
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
            const resp = await this.execute_swap(
                storage,
                payable.route,
                this.token,
                amount.toString(),
                payable.output_amount.toFixed(0, BigNumber.ROUND_DOWN)
            )
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

        try {
            await this.withdraw_tokens(storage, candidate.market_info)
        } finally {
            await storage.update_user_balance()
        }
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

    private async withdraw_tokens(storage: Storage, market: LendOverseerMarket) {
        const contract = new LendMarket(
            storage.client,
            market.contract.address,
            market.contract.code_hash
        )

        const [state, balance] = await Promise.all([
            contract.getState(storage.block_height),
            contract.getUnderlyingBalance(
                LendAuth.permit(new SecretJsSigner(storage))
            )
        ])

        const market_supply = new BigNumber(state.underlying_balance)
        const user_balance = new BigNumber(balance)

        const amount = clamp(user_balance, market_supply)
        const value = storage.usd_value(amount, market.symbol, market.decimals)
        const cost = storage.gas_cost_usd(
            storage.config.gas_costs.withdraw
        )

        if (value.lt(cost)) {
            console.log(`Skipping redeeming ${balance} ${market.symbol} because the market supply is insufficient or its value is less than the cost of the TX.`)

            return
        }

        const resp = await Tx.retry(() => {
            return contract.redeemFromUnderlying(
                amount.toString()
            )},
            TX_RETRY_COUNT
        ) as SecretJS.TxResponse

        Tx.assert_resp_ok(resp)
        const withdrawn_amount = Tx.get_value(resp, 'redeem_amount')!
        
        const route = this.routes.get(market.contract.address + this.token.address)

        if (!route) {
            console.info(`Transferred ${withdrawn_amount} ${market.symbol} to wallet but no route exists to swap them back to ${storage.config.token.symbol}`)

            return
        }

        await this.execute_swap(storage, route, market.contract, withdrawn_amount)
    }

    private async execute_swap(
        storage: Storage,
        route: SwapRoute,
        from_token: ContractLink,
        swap_amount: string,
        expected_return?: string
    ): Promise<SecretJS.TxResponse> {
        let resp: SecretJS.TxResponse

        if (route_is_pair(route)) {
            const pair = new AMMExchange(storage.client, route.address, route.code_hash)

            resp = await Tx.retry(
                () => pair.swap(
                    new TokenAmount(
                        customToken(from_token.address, from_token.code_hash),
                        swap_amount,
                    ),
                    expected_return
                ),
                TX_RETRY_COUNT
            ) as SecretJS.TxResponse
        } else {
            const router = new AMMRouter(
                storage.client,
                storage.config.router.address,
                storage.config.router.code_hash
            )
            
            resp = await Tx.retry(
                () => router.swap(
                    route,
                    swap_amount,
                    expected_return
                ),
                TX_RETRY_COUNT
            ) as SecretJS.TxResponse
        }

        Tx.assert_resp_ok(resp)

        return resp
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
