import {
    ScrtAgent, Multicall, Address, ContractLink,
    TokenPair, Snip20, Permit
} from 'siennajs'
import { Config } from './liquidator'
import { normalize_denom } from './math'
import * as Tx from './tx'

import { b64encode, b64decode } from '@waiting/base64'
import BigNumber from 'bignumber.js'
import fetch from 'node-fetch'

const POOL_INFO_CACHE_TIME: number = 3 * 60 * 1000
const DECIMALS_BATCH: number = 15
const POOLS_BATCH: number = 10

export interface PoolInfo {
    amount_0: BigNumber,
    amount_1: BigNumber,
    pair: TokenPair
}

interface PriceResult {
    symbol: string,
    multiplier: string,
    px: string,
    request_id: string,
    resolve_time: string
}

export class Storage {
    public pool_cache: TimedCache<PoolInfo>
    public decimals_cache: TimedCache<number>
    public prices: Record<string, number> = { }
    public block_height: number = 0
    public user_balance = new BigNumber(0)
    public permits = new Map<string, Permit<any>>

    public static async init(
        client: ScrtAgent,
        config: Config,
        price_symbols: Set<string>
    ): Promise<Storage> {
        price_symbols.add(config.token.symbol)
        price_symbols.add('SCRT') // We always need SCRT, in order to check gas costs

        const instance = new this(config, client, price_symbols)

        await Promise.all([
            instance.update_block_height(),
            instance.update_user_balance(),
            instance.update_prices()
        ])

        return instance
    }

    private constructor(
        public config: Config,
        public client: ScrtAgent,
        price_symbols: Set<string>
    ) {
        for (const symbol of price_symbols) {
            this.prices[symbol] = 0
        }

        const multicall = new Multicall(client, config.multicall.address, config.multicall.code_hash)

        this.pool_cache = new TimedCache<PoolInfo>(
            multicall,
            POOL_INFO_CACHE_TIME,
            POOLS_BATCH,
            'pair_info',
            (item) => {
                const info = item.pair_info

                return {
                    amount_0: new BigNumber(info.amount_0),
                    amount_1: new BigNumber(info.amount_1),
                    pair: info.pair
                }
            }
        )
        this.decimals_cache = new TimedCache<number>(
            multicall,
            Infinity,
            DECIMALS_BATCH,
            { token_info: { } },
            (item) => item.token_info.decimals
        )
    }

    gas_cost_usd(amount: BigNumber.Value): BigNumber {
        return this.usd_value(amount, 'SCRT', 6)
    }

    usd_value(
        amount: BigNumber.Value,
        symbol: string,
        decimals: number
    ): BigNumber {
        return normalize_denom(
            new BigNumber(this.prices[symbol]).multipliedBy(amount),
            decimals
        )
    }

    async update_prices() {
        const symbols = Object.keys(this.prices).map(x => `symbols=${x}`)
        
        const resp = await fetch(`${this.config.band_url}/oracle/v1/request_prices?${symbols.join('&')}`)
        const prices: {price_results: PriceResult[]} = await resp.json()

        prices.price_results.forEach((x: any) => {
            const price = new BigNumber(x.px).dividedBy(x.multiplier).toNumber()
            this.prices[x.symbol] = price
        })
    }

    async update_block_height() {
        const height = await this.client.chain?.height

        if (!height) {
            throw new Error("Couldn't fetch current block height.")
        }

        this.block_height = height
    }

    async update_user_balance() {
        const token = this.config.token
        const token_contract = new Snip20(this.client, token.address, token.code_hash)

        const balance = await Tx.retry(() =>
            token_contract.getBalance(this.client.address!, token.underlying_vk)
        )

        this.user_balance = new BigNumber(balance)
    }
}

export class TimedCache<T> {
    private cache: Map<Address, [T, number]> = new Map()
    private query: string
    private outbound: Map<Address, Promise<[number, T][]>> = new Map()

    constructor(
        private multicall: Multicall,
        private expiration: number,
        private batch_size: number,
        query: any,
        private on_item: (item: any) => T
    ) {
        this.query = b64encode(JSON.stringify(query))
    }

    async get(contract: ContractLink): Promise<T> {
        const result = await this.get_many([contract])

        return result[0]
    }

    async get_many(contracts: ContractLink[]): Promise<T[]> {
        const result: (T | null)[] = []

        let buffer: [number, ContractLink][] = []
        const requests: Promise<[number, T][]>[] = []

        for (const [i, contract] of contracts.entries()) {
            const value = this.cache.get(contract.address)

            if (value && Date.now() - value[1] < this.expiration)
                result.push(value[0])
            else {
                const request = this.outbound.get(contract.address)

                if (request) {
                    await request
                    result.push(this.cache.get(contract.address)![0])
                } else {
                    result.push(null)
                    buffer.push([i, contract])
                }
            }
            if (
                buffer.length === this.batch_size ||
                (buffer.length > 0 && i == contracts.length - 1)
            ) {
                const batch = this.batch_call(buffer)
                buffer.forEach(x => this.outbound.set(x[1].address, batch))
                requests.push(batch)

                buffer = []
            }
        }

        const responses = await Promise.all(requests)

        for (const response of responses) {
            for (const item of response) {
                const i = item[0]
                const value = item[1]

                result[i] = value
            }
        }

        return result as T[]
    }

    private async batch_call(buffer: [number, ContractLink][]): Promise<[number, T][]> {
        const items: [number, T][] = []
        const resp = await this.multicall.multiChain(buffer.map((x) => {
            return {
                contract_address: x[1].address,
                code_hash: x[1].code_hash,
                query: this.query
            }
        }))

        const now = Date.now()

        for (const [i, res] of resp.entries()) {
            if (res.error) {
                throw new Error(b64decode(res.error))
            }

            const data = JSON.parse(b64decode(res.data!))
            const item = this.on_item(data)

            items.push([buffer[i][0], item])

            const address = buffer[i][1].address 
            this.cache.set(address, [item, now])
            this.outbound.delete(address)
        }

        return items
    }
}
