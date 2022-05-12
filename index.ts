import fs from 'fs'
import YAML from 'yaml'

import { Liquidator, Config } from "./src/liquidator";

async function main() {
    const file = fs.readFileSync('./config.yml', 'utf8')
    const config: Config = YAML.parse(file)
    
    const liquidator = await Liquidator.create(config)
    await liquidator.start()
}

main().catch(err => console.error(err))
