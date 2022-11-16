import {
    Scrt, LendOverseer, LendMarket, LendOverseerMarket,
    LendMarketBorrower, PaginatedResponse, Snip20, Address,
    Agent, ViewingKey, Pagination, Fee, CodeHash
} from "siennajs"
import BigNumber from 'bignumber.js'
import fetch from 'node-fetch'

BigNumber.config({
    EXPONENTIAL_AT: 1e9,
    ROUNDING_MODE: BigNumber.ROUND_DOWN
})

const LIQUIDATE_COST = 550_000
const BLACKLISTED_SYMBOLS = ['LUNA', 'UST']

export interface Config {
    markets: MarketConfig[],
    band_url: string,
    api_url: string,
    chain_id: string,
    mnemonic: string,
    interval: number,
    overseer: OverseerConfig
}

export interface OverseerConfig {
    address: Address,
    code_hash: CodeHash
}

export interface MarketConfig {
    address: Address,
    underlying_vk: ViewingKey
    code_hash: CodeHash
}

interface Market {
    contract: LendMarket,
    code_hash: CodeHash,
    decimals: number,
    symbol: string,
    user_balance: BigNumber
}

interface LendConstants {
    close_factor: number,
    premium: number
}

interface Candidate {
    id: string,
    payable: BigNumber,
    seizable_usd: BigNumber,
    market_info: LendOverseerMarket
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

        for(const market_config of config.markets) {
            const match = all_markets.find(x => x.contract.address == market_config.address)

            if (!match) {
                throw new Error(`Market ${market_config.address} doesn't exist in overseer ${config.overseer}`)
            }

            const contract = new LendMarket(client, market_config.address, market_config.code_hash)
            contract.fees.liquidate = new Fee(LIQUIDATE_COST, 'uscrt')

            // Fetch user balance for this underlying token.
            const token = await retry(() => contract.getUnderlyingAsset())

            const token_contract = new Snip20(client,token.address, token.code_hash)
            const balance = await retry(() =>
                token_contract.getBalance(client.address!, market_config.underlying_vk)
            )

            if (balance != '0') {
                const market: Market = {
                    contract,
                    decimals: match.decimals,
                    symbol: match.symbol,
                    user_balance: new BigNumber(balance),
                    code_hash: market_config.code_hash
                }

                markets.push(market)
            }
        }

        const price_symbols = new Set(all_markets.map(x => x.symbol))
        price_symbols.add('SCRT') // We always need SCRT, in order to check gas costs

        console.info('Operating with markets:')
        markets.forEach((x) => {
            console.info(`Market: ${x.contract.address}`)
            console.info(`Wallet balance: ${x.user_balance}\n`)
        })

        return new this(
            client,
            config,
            markets,
            [...price_symbols],
            constants
        )
    }
    
    private constructor(
        private client: Agent,
        private config: Config,
        private markets: Market[],
        private price_symbols: string[],
        private constants: LendConstants
    ) { }

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

        if (this.markets.length == 0) {
            console.info('Wallet underlying balance in all markets is 0. Terminating...')
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
            let index = 0
    
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

            const market = this.markets[index]
            const result: any = await retry(() => {
                    // TS trippin' here
                    const loan = best_loan as any;

                    return market.contract.liquidate(
                        loan.payable.toFixed(0),
                        loan.id,
                        loan.market_info.contract.address
                    )   
                },
                3
            )

            const repaid_amount = normalize_denom(best_loan.payable, market.decimals)
            console.info(`Successfully liquidated a loan by repaying ${repaid_amount.toString()} ${market.symbol} and seized ~$${best_loan.seizable_usd} worth of ${best_loan.market_info.symbol} (transfered to market: ${best_loan.market_info.contract.address})!`)
            console.info(`TX hash: ${result.transactionHash}`)

            market.user_balance = market.user_balance.minus(best_loan.payable)

            if (market.user_balance.isZero()) {
                console.info(`Ran out of balance for market ${market.contract.address}. Removing...`)
                this.markets.splice(index, 1)
            }
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
            const payable = this.payable(market, borrower)
            
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

        const tx_cost = normalize_denom(new BigNumber(LIQUIDATE_COST * this.prices['SCRT']), 6)

        if (best_candidate && tx_cost.gt(best_candidate.seizable_usd))
            return null

        return best_candidate
    }

    private async process_candidate(
        market: Market,
        borrower: LendMarketBorrower,
        exchange_rate: BigNumber
    ): Promise<{ best_case: boolean, candidate: Candidate }> {
        const payable = this.payable(market, borrower)

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

    private payable(market: Market, borrower: LendMarketBorrower): BigNumber {
        return clamp(
            new BigNumber(borrower.actual_balance).multipliedBy(this.constants.close_factor),
            market.user_balance
        )
    }
}

function clamp(val: BigNumber, max: BigNumber) {
    if (val.gt(max))
        return max

    return val
}

function normalize_denom(amount: BigNumber, decimals: number): BigNumber {
    return amount.dividedBy(10 ** decimals)
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

async function retry<T>(func: () => Promise<T>, retries: number = 5): Promise<T> {
    do {
        try {
            const result = await func()

            return result
        } catch (e: any) {
            // generic_err means the error was caused by contract logic,
            // so repeating the same request would yield the same result
            if (e.message && e.message.includes('generic_err')) {
                throw e
            }

            retries--
        }     
    } while(retries > 0)

    throw new Error('Ran out of retries for a single query or a TX.')
}
