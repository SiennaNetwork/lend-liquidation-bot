import {
    Scrt, LendOverseer, LendMarket, LendOverseerMarket,
    LendMarketBorrower, PaginatedResponse, Snip20, Address,
    Agent, ViewingKey, Pagination, Fee, CodeHash, ContractLink,
    Multicall, AMMRouter, AMMFactory
} from "siennajs"
import BigNumber from 'bignumber.js'
import fetch from 'node-fetch'

import { LiquidationsManager } from './swap'
import { retry, normalize_denom } from './utils'

BigNumber.config({
    EXPONENTIAL_AT: 1e9,
    ROUNDING_MODE: BigNumber.ROUND_DOWN
})

const LIQUIDATE_COST = 550_000
const BLACKLISTED_SYMBOLS = ['LUNA', 'UST']

export interface Config {
    band_url: string,
    api_url: string,
    chain_id: string,
    mnemonic: string,
    interval: number,
    overseer: ContractLink,
    multicall: ContractLink,
    router: ContractLink,
    factory: ContractLink,
    token: TokenInfo
}

export interface TokenInfo {
    address: Address,
    underlying_vk: ViewingKey
    code_hash: CodeHash
}

export interface Market {
    contract: LendMarket,
    decimals: number,
    symbol: string,
    underlying: ContractLink
}

export interface Candidate {
    id: string,
    payable: BigNumber,
    seizable_usd: BigNumber,
    market_info: LendOverseerMarket
}

interface LendConstants {
    close_factor: number,
    premium: number
}

interface PriceResult {
    symbol: string,
    multiplier: string,
    px: string,
    request_id: string,
    resolve_time: string
}

export class Liquidator {
    private handle?: NodeJS.Timer
    private is_executing: boolean = false
    private prices: Record<string, number> = { }
    private current_height = 0
    private user_balance = new BigNumber(0)
    private multicall: Multicall

    static async create(config: Config): Promise<Liquidator> {
        const chain = new Scrt(config.chain_id, { url: config.api_url });
        const client = await chain.getAgent({ mnemonic: config.mnemonic })

        const overseer = new LendOverseer(client, config.overseer.address, config.overseer.code_hash)

        const overseer_config = await overseer.config()
        const constants = {
            close_factor: parseFloat(overseer_config.close_factor),
            premium: parseFloat(overseer_config.premium)
        }

        const all_markets = await fetch_all_pages(
            (page) => retry(() => overseer.getMarkets(page)),
            30,
            (x) => !BLACKLISTED_SYMBOLS.includes(x.symbol)
        )

        const markets: Market[] = []

        for(const market of all_markets) {
            const contract = new LendMarket(client, market.contract.address, market.contract.code_hash)
            contract.fees.liquidate = new Fee(LIQUIDATE_COST, 'uscrt')

            const m: Market = {
                contract,
                decimals: market.decimals,
                symbol: market.symbol,
                underlying: await contract.getUnderlyingAsset()
            }

            markets.push(m)
        }

        const price_symbols = new Set(all_markets.map(x => x.symbol))
        price_symbols.add('SCRT') // We always need SCRT, in order to check gas costs

        const router = new AMMRouter(client, config.router.address, config.router.code_hash)
        router.supportedTokens = await router.getSupportedTokens()

        const factory = new AMMFactory['v2'](client, config.factory.address, config.factory.code_hash)
        const manager = await LiquidationsManager.init(router, factory, markets, config.token)

        const instance = new this(
            client,
            config,
            markets,
            [...price_symbols],
            constants,
            manager
        )

        await instance.update_user_balance()
        console.info(`Operating with balance: ${instance.user_balance}`)

        return instance
    }
    
    private constructor(
        private client: Agent,
        private config: Config,
        private markets: Market[],
        private price_symbols: string[],
        private constants: LendConstants,
        private manager: LiquidationsManager
    ) {
        this.multicall = new Multicall(client, config.multicall.address, config.multicall.code_hash)
    }

    start() {
        this.handle = setInterval(
            async () => this.run_liquidations_round(),
            this.config.interval
        )
    }

    stop() {
        if (this.handle) {
            clearInterval(this.handle)
        }
    }

    async run_once() {
        return this.run_liquidations_round()
    }

    private async run_liquidations_round() {
        if (this.is_executing) {
            return
        }


        if (this.user_balance.isZero()) {
            console.info('Ran out of balance. Terminating...')
            this.stop()

            return
        }

        this.is_executing = true

        try {
            const height = await this.client.chain?.height

            if (!height) {
                throw new Error("Couldn't fetch current block height.")
            }

            this.current_height = height
            await this.fetch_prices()
    
            const candidates = await Promise.all(this.markets.map(x => this.market_candidate(x)))
            let best_loan: Candidate | null = candidates[0]
            let index = -1
    
            candidates.forEach((loan, i) => {
                if (!loan)
                    return
    
                if (!best_loan || best_loan.seizable_usd.lt(loan.seizable_usd)) {
                    best_loan = loan
                    index = i
                }
            })
    
            if (!best_loan) {
                console.info("Couldn't find a good loan to liquidate this round...")
    
                return
            }

            await this.manager.liquidate(this.markets[index], best_loan)
            await this.update_user_balance()
        } catch (e: any) {
            console.error(`Caught an error during liquidations round: ${JSON.stringify(e, null, 2)}`)

            if (e.stack) {
                console.error(e.stack)
            }
        } finally {
            this.is_executing = false
        }
    }

    private async fetch_prices() {
        const symbols = this.price_symbols.map(x => `symbols=${x}`)
        
        const resp = await fetch(`${this.config.band_url}/oracle/v1/request_prices?${symbols.join('&')}`)
        const prices: {price_results: PriceResult[]} = await resp.json()

        prices.price_results.forEach((x: any) => {
            const price = new BigNumber(x.px).dividedBy(x.multiplier).toNumber()
            this.prices[x.symbol] = price
        })
    }

    private async market_candidate(market: Market): Promise<Candidate | null> {
        const candidates = await fetch_all_pages(
            async (page) => {
                const result = await retry(() =>
                    market.contract.getBorrowers(page, this.current_height)
                )

                // Yes, we've come down to this because secretjs returns a string when
                // a contract error occurs...
                if (result.hasOwnProperty('entries') &&
                    result.hasOwnProperty('total')
                ) {
                    return result
                }

                return null
            },
            1,
            (x) => {
                if (x.liquidity.shortfall == '0')
                    return false

                x.markets = x.markets.filter(m => !BLACKLISTED_SYMBOLS.includes(m.symbol))

                return x.markets.length != 0
            }
        )

        if (candidates.length == 0) {
            console.info(`No liquidatable loans currently in ${market.contract.address}. Skipping...`)

            return null
        }

        return this.find_best_candidate(market, candidates)
    }

    private async find_best_candidate(market: Market, borrowers: LendMarketBorrower[]): Promise<Candidate | null> {
        const exchange_rate_request = retry(() =>
            market.contract.getExchangeRate(this.current_height)
        )

        const sort_by_price = (a: LendOverseerMarket, b: LendOverseerMarket) => {
            const price_a = this.prices[a.symbol]
            const price_b = this.prices[b.symbol]

            return price_b - price_a
        }
        borrowers.forEach(x => x.markets.sort(sort_by_price))

        const calc_net = (borrower: LendMarketBorrower) => {
            const payable = this.max_payable(borrower)
            
            return payable.multipliedBy(this.constants.premium)
                .multipliedBy(this.prices[borrower.markets[0].symbol])
                .dividedBy(this.prices[market.symbol])
        }

        borrowers.sort((a, b) => {
            const net_a = calc_net(a)
            const net_b = calc_net(b)

            if (net_a.isEqualTo(net_b)) {
                return sort_by_price(a.markets[0], b.markets[0])
            }

            return net_b.minus(net_a).toNumber()
        })
        
        const exchange_rate = new BigNumber(await exchange_rate_request)
        let best_candidate: Candidate | null = null
        
        // Because we sort the borrowers based on the best case scenario
        // (where full liquidation is possible and receiving the best priced collateral)
        // we can only make assumptions about whether the current loan is the best one to liquidate
        // if we hit the best case scenario for it. So we compare loans in pairs, starting from the `hypothetical`
        // best one and stopping as soon as the best case was encountered for either loan in the current pair.
        // Otherwise, continue to the next pair.
        for(let i = 0; i < borrowers.length; i++) {
            const a = await this.process_candidate(market, borrowers[i], exchange_rate)

            if (a.best_case || i == borrowers.length - 1) {
                best_candidate = a.candidate

                break
            }

            const b = await this.process_candidate(market, borrowers[i + 1], exchange_rate)

            if (b.candidate.seizable_usd.gt(a.candidate.seizable_usd)) {
                best_candidate = b.candidate

                if (b.best_case) {
                    break
                }
            } else {
                best_candidate = a.candidate

                break
            }

            i += 1
        }

        if (best_candidate && this.liquidation_cost_usd().gt(best_candidate.seizable_usd))
            return null

        return best_candidate
    }

    private async process_candidate(
        market: Market,
        borrower: LendMarketBorrower,
        exchange_rate: BigNumber
    ): Promise<{ best_case: boolean, candidate: Candidate }> {
        const payable = this.max_payable(borrower)

        let best_seizable_usd = new BigNumber(0)
        let best_payable = new BigNumber(0)
        let market_index = 0

        if (payable.lt(1)) {
            return {
                best_case: true,
                candidate: {
                    id: borrower.id,
                    payable: best_payable,
                    seizable_usd: best_seizable_usd,
                    market_info: borrower.markets[market_index]
                }
            }
        }

        for (let i = 0; i < borrower.markets.length; i++) {
            const m = borrower.markets[i]

            // Values are in sl-tokens so we need to convert to
            // the underlying in order for them to be useful here.
            const info = await retry(() =>
                market.contract.simulateLiquidation(
                    borrower.id,
                    m.contract.address,
                    payable.toFixed(0),
                    this.current_height
                )
            )

            const seizable = new BigNumber(info.seize_amount).multipliedBy(exchange_rate)

            if (i == 0 && info.shortfall == '0') {
                // We can liquidate using the most profitable asset so no need to go further.
                return {
                    best_case: true,
                    candidate: {
                        id: borrower.id,
                        payable,
                        seizable_usd: normalize_denom(seizable.multipliedBy(this.prices[m.symbol]), m.decimals),
                        market_info: m
                    }
                }
            }

            let actual_payable;
            let actual_seizable_usd;

            let done = false

            if(info.shortfall == '0') {
                actual_payable = payable
                actual_seizable_usd = normalize_denom(seizable.multipliedBy(this.prices[m.symbol]), m.decimals)

                // We don't have to check further since this is the second best scenario that we've got.
                done = true
            } else {
                // Otherwise check by how much we'd need to decrease our repay amount in order for the
                // liquidation to be successful and also decrease the seized amount by that percentage.
                const actual_seizable = new BigNumber(info.seize_amount).minus(info.shortfall)

                // TODO: can this be less than 0?
                if (actual_seizable.isZero()) {
                    actual_payable = new BigNumber(0)
                    actual_seizable_usd = new BigNumber(0)
                } else {
                    const seizable_price = actual_seizable.multipliedBy(this.prices[m.symbol]).multipliedBy(exchange_rate)
                    const borrowed_premium = new BigNumber(this.constants.premium).multipliedBy(this.prices[market.symbol])
                
                    actual_payable = seizable_price.dividedBy(borrowed_premium)
    
                    actual_seizable_usd = normalize_denom(
                        actual_seizable.multipliedBy(this.prices[m.symbol]),
                        m.decimals
                    )
                }
            }

            if (actual_seizable_usd.gt(best_seizable_usd)) {
                best_payable = actual_payable
                best_seizable_usd = actual_seizable_usd
                market_index = i

                if (done)
                    break
            }
        }

        return {
            best_case: false,
            candidate: {
                id: borrower.id,
                payable: best_payable,
                seizable_usd: best_seizable_usd,
                market_info: borrower.markets[market_index]
            }
        }
    }

    private async update_user_balance() {
        const token = this.config.token
        const token_contract = new Snip20(this.client, token.address, token.code_hash)

        const balance = await retry(() =>
            token_contract.getBalance(this.client.address!, token.underlying_vk)
        )

        this.user_balance = new BigNumber(balance)
    }

    private max_payable(borrower: LendMarketBorrower): BigNumber {
        return new BigNumber(borrower.actual_balance).multipliedBy(this.constants.close_factor)
    }

    private liquidation_cost_usd(): BigNumber {
        return normalize_denom(new BigNumber(LIQUIDATE_COST * this.prices['SCRT']), 6)
    }
}

async function fetch_all_pages<T>(
    query: (pagination: Pagination) => Promise<PaginatedResponse<T> | null>,
    limit: number,
    filter?: (x: T) => boolean
): Promise<T[]> {
    let start = 0;
    let total = 0;

    const result: T[] = []

    do {
        const page = await query({
            start,
            limit
        })

        if (page == null) {
            start += limit
            continue
        }

        total = page.total
        start += limit

        if (filter) {
            page.entries.forEach(x => {
                if (filter(x))
                    result.push(x)
            })
        } else {
            page.entries.forEach(x => result.push(x))
        }

    } while(start <= total)

    return result
}
