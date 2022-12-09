import { Permit, PermitAminoMsg, Signer } from 'siennajs'
import { Storage } from './storage'

export class SecretJsSigner implements Signer {
    public get chain_id() {
        return this.storage.config.chain_id
    }

    public get address() {
        return this.storage.client.address!
    }

    constructor(private storage: Storage) { }

    async sign<T>(permit_msg: PermitAminoMsg<T>): Promise<Permit<T>> {
        if (permit_msg.allowed_tokens.length > 1)
            throw new Error(`SecretJsSigner only supports one address per permit.`)

        const address = permit_msg.allowed_tokens[0]
        let permit = this.storage.permits.get(address)

        if(permit)
            return permit
        
        permit = await this.storage.client.api.utils.accessControl.permit.sign(
            this.address,
            this.chain_id,
            permit_msg.permit_name,
            [ address ],
            // This method assumes SNIP-20 token permissions but we have custom ones
            // @ts-ignore
            permit_msg.permissions,
            false
        )

        this.storage.permits.set(address, permit)

        return permit
    }
}
