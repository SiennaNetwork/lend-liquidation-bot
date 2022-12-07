import { SecretJS } from "siennajs"

export async function retry<T>(func: () => Promise<T>, retries: number = 5): Promise<T> {
    do {
        try {
            const result = await func()

            return result
        } catch (e: any) {
            retries--

            // generic_err means the error was caused by contract logic,
            // so repeating the same request would yield the same result
            if (e.message) {
                console.error(`Caught error (retries left: ${retries}): ${e.message}`)

                if (e.stack)
                    console.error(`Trace: ${e.stack}`)

                if (
                    e.message.includes('generic_err') ||
                    e.message.includes('parse_err')
                ) {
                    throw e
                }
            }
        }     
    } while(retries > 0)
    
    throw new Error('Ran out of retries for a single query or a TX.')
}

export function assert_resp_ok(resp: SecretJS.TxResponse) {
    if(resp.code != 0)
        throw new Error(`TX (${resp.transactionHash}) error: ${resp.rawLog}`)
}

export function get_value(resp: SecretJS.TxResponse, key: string): string | undefined {
    if (!resp.jsonLog || resp.jsonLog.length == 0)
        return undefined

    const wasm = resp.jsonLog[0].events.find(x => x.type === 'wasm')
    const attrs = wasm?.attributes ?? []

    for (let i = attrs.length - 1; i >= 0; i--) {
        const attr = attrs[i]

        if (attr.key === key)
            return attr.value
    }

    return undefined
}
