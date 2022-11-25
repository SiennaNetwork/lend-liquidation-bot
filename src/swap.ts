import {
    ContractLink, AMMRouter, AMMFactory, AMMRouterHop,
    AMMRouterPair, ExchangeSettings, ExchangeFee, customToken
} from "siennajs"
import BigNumber from 'bignumber.js'

import { Market, Candidate } from './liquidator'
import { retry, normalize_denom } from "./utils"

export class LiquidationsManager {
    static async init(
        router: AMMRouter,
        factory: AMMFactory,
        markets: Market[],
        token_info: ContractLink
    ): Promise<LiquidationsManager> {
        const routes: Map<string, ContractLink | AMMRouterHop[]> = new Map()

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
        private routes: Map<string, ContractLink | AMMRouterHop[]>,
        private fees: ExchangeSettings
    ) {}

    async liquidate(market: Market, loan: Candidate) {
        const amount = loan.payable.decimalPlaces(0, BigNumber.ROUND_DOWN)

        const result: any = await retry(() => {
                return market.contract.liquidate(
                    amount.toString(),
                    loan.id,
                    loan.market_info.contract.address
                )   
            },
            3
        )

        const repaid_amount = normalize_denom(amount, market.decimals)
        console.info(`Successfully liquidated a loan by repaying ${repaid_amount.toString()} ${market.symbol} and seized ~$${loan.seizable_usd} worth of ${loan.market_info.symbol} (transfered to market: ${loan.market_info.contract.address})!`)
        console.info(`TX hash: ${result.transactionHash}`)
    }

    private compute_swap(
        offer_pool: BigNumber,
        ask_pool: BigNumber,
        offer_amount: BigNumber
    ): {
        return_amount: BigNumber
        spread_amount: BigNumber
    } {
        // https://github.com/SiennaNetwork/sienna/blob/2f75175212278c289ea27270cf20cbdfb62a4b90/contracts/exchange/src/contract.rs#L637-L644
    
        // Could do this with a single call, but keeping it like this in
        // order to stay closer to the actual calculations in the contract
        const swap_commission = percentage_decrease(offer_amount, this.fees.swap_fee)
        const sienna_commission = percentage_decrease(offer_amount, this.fees.sienna_fee)
    
        // https://github.com/SiennaNetwork/sienna/blob/2f75175212278c289ea27270cf20cbdfb62a4b90/contracts/exchange/src/contract.rs#L661-L662
        const total_commission = swap_commission.plus(sienna_commission)
        offer_amount = offer_amount.minus(total_commission)
    
        // https://github.com/SiennaNetwork/sienna/blob/2f75175212278c289ea27270cf20cbdfb62a4b90/contracts/exchange/src/contract.rs#L673-L694
        const total_pool = offer_pool.multipliedBy(ask_pool)
        const return_amount = ask_pool.minus(total_pool.dividedBy(offer_pool.plus(offer_amount)))
    
        // spread = offer_amount * ask_pool / offer_pool - return_amount
        const spread_amount = offer_amount
            .multipliedBy(ask_pool.dividedBy(offer_pool))
            .minus(return_amount)
    
        return {
            return_amount,
            spread_amount,
        }
    }
}

function percentage_decrease(amount: BigNumber, fee: ExchangeFee): BigNumber {
    return amount.multipliedBy(fee.nom).dividedBy(fee.denom)
}  
