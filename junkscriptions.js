#!/usr/bin/env node
const dogecore = require('./bitcore-lib-junkcoin');
const axios = require('axios')
const fs = require('fs')
const dotenv = require('dotenv')
const mime = require('mime-types')
const express = require('express')
const { PrivateKey, Address, Transaction, Script, Opcode } = dogecore
const { Hash, Signature } = dogecore.crypto

dotenv.config()

if (process.env.TESTNET == 'true') {
    dogecore.Networks.defaultNetwork = dogecore.Networks.testnet
}

if (process.env.FEE_PER_KB) {
    Transaction.FEE_PER_KB = parseInt(process.env.FEE_PER_KB)
} else {
    Transaction.FEE_PER_KB = 5000000
}

const WALLET_PATH = process.env.WALLET || '.wallet.json'
const MAX_SCRIPT_ELEMENT_SIZE = 520
const MAX_CHUNK_LEN = 240
const MAX_PAYLOAD_LEN = 1500
const DUST_AMOUNT = 100000 // 0.001 JKC minimum for dust threshold
const INSCRIPTION_AMOUNT = 500000 // 0.005 JKC for inscription outputs

async function main() {
    let cmd = process.argv[2]

    if (fs.existsSync('pending-txs.json')) {
        console.log('found pending-txs.json. rebroadcasting...')
        const txs = JSON.parse(fs.readFileSync('pending-txs.json'))
        await broadcastAll(txs.map(tx => new Transaction(tx)), false)
        return
    }

    if (cmd == 'mint') {
        await mint()
    } else if (cmd == 'wallet') {
        await wallet()
    } else if (cmd == 'server') {
        await server()
    } else if (cmd == 'jkc-20') {
        await jkc20()
    } else {
        throw new Error(`unknown command: ${cmd}`)
    }
}

async function jkc20() {
  let subcmd = process.argv[3]

  if (subcmd === 'mint') {
    await jkc20Transfer("mint")
  } else if (subcmd === 'transfer') {
    await jkc20Transfer()
  } else if (subcmd === 'deploy') {
    await jkc20Deploy()
  } else {
    throw new Error(`unknown subcommand: ${subcmd}`)
  }
}

async function jkc20Deploy() {
  const argAddress = process.argv[4]
  const argTicker = process.argv[5]
  const argMax = process.argv[6]
  const argLimit = process.argv[7]

  const jkc20Tx = {
    p: "jkc-20",
    op: "deploy",
    tick: `${argTicker.toLowerCase()}`,
    max: `${argMax}`,
    lim: `${argLimit}`
  };

  const parsedjkc20Tx = JSON.stringify(jkc20Tx);
  const encodedjkc20Tx = Buffer.from(parsedjkc20Tx).toString('hex');

  console.log("Deploying jkc-20 token...");
  await mint(argAddress, "text/plain;charset=utf-8", encodedjkc20Tx);
}

async function jkc20Transfer() {
  const argAddress = process.argv[4]
  const argTicker = process.argv[5]
  const argAmount = process.argv[6]
  const argRepeat = Number(process.argv[7]) || 1;

  const jkc20Tx = {
    p: "jkc-20",
    op: "transfer",
    tick: `${argTicker.toLowerCase()}`,
    amt: `${argAmount}`
  };

  const parsedjkc20Tx = JSON.stringify(jkc20Tx);
  const encodedjkc20Tx = Buffer.from(parsedjkc20Tx).toString('hex');

  for (let i = 0; i < argRepeat; i++) {
    console.log("Minting jkc-20 token...", i + 1, "of", argRepeat, "times");
    await mint(argAddress, "text/plain;charset=utf-8", encodedjkc20Tx);
  }
}

async function wallet() {
    let subcmd = process.argv[3]

    if (subcmd == 'new') {
        walletNew()
    } else if (subcmd == 'sync') {
        await walletSync()
    } else if (subcmd == 'balance') {
        walletBalance()
    } else if (subcmd == 'send') {
        await walletSend()
    } else if (subcmd == 'split') {
        await walletSplit()
    } else {
        throw new Error(`unknown subcommand: ${subcmd}`)
    }
}

async function walletNew() {
    if (!fs.existsSync(WALLET_PATH)) {
        const privateKey = new PrivateKey()
        const privkey = privateKey.toWIF()
        const address = privateKey.toAddress().toString()
        const json = { privkey, address, utxos: [] }
        fs.writeFileSync(WALLET_PATH, JSON.stringify(json, 0, 2))
        
        // Import private key to core wallet
        try {
            const body = {
                jsonrpc: "1.0",
                id: "importprivkey",
                method: "importprivkey",
                params: [privkey, "junkscriptions", false]
            }

            const options = {
                auth: {
                    username: process.env.NODE_RPC_USER,
                    password: process.env.NODE_RPC_PASS
                }
            }

            await axios.post(process.env.NODE_RPC_URL, body, options)
            console.log('Created new wallet and imported to core wallet')
            console.log('Address:', address)
            console.log('Private Key:', privkey)
            console.log('\nIMPORTANT: Save your private key securely!')
            console.log('\nBefore minting, you need to:')
            console.log('1. Fund this address with JKC')
            console.log('2. Run: node junkscriptions.js wallet sync')
        } catch (error) {
            console.error('Error importing to core wallet:', error.message)
            if (error.response && error.response.data) {
                console.error('RPC Error:', error.response.data.error)
            }
            // Still create local wallet even if core wallet import fails
            console.log('\nLocal wallet created but core wallet import failed')
            console.log('Address:', address)
            console.log('Private Key:', privkey)
            console.log('\nIMPORTANT: Save your private key securely!')
            console.log('\nBefore minting, you need to:')
            console.log('1. Fund this address with JKC')
            console.log('2. Run: node junkscriptions.js wallet sync')
        }
    } else {
        throw new Error('wallet already exists')
    }
}

async function walletSync() {
    let wallet = JSON.parse(fs.readFileSync(WALLET_PATH))

    console.log('syncing utxos with local Junkcoin node via RPC')

    const body = {
        jsonrpc: "1.0",
        id: "walletsync",
        method: "listunspent",
        params: [0, 9999999, [wallet.address]]
    }

    const options = {
        auth: {
            username: process.env.NODE_RPC_USER,
            password: process.env.NODE_RPC_PASS
        }
    }

    let response = await axios.post(process.env.NODE_RPC_URL, body, options)
    let utxos = response.data.result

    wallet.utxos = utxos.map(utxo => {
        return {
            txid: utxo.txid,
            vout: utxo.vout,
            script: utxo.scriptPubKey,
            satoshis: Math.floor(utxo.amount * 1e8) // Convert from JKC to satoshis, ensure integer
        }
    })

    fs.writeFileSync(WALLET_PATH, JSON.stringify(wallet, 0, 2))
    let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0)
    console.log('Balance:', balance/1e8, 'JKC')
}

function walletBalance() {
    let wallet = JSON.parse(fs.readFileSync(WALLET_PATH))
    let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0)
    console.log(wallet.address, balance/1e8, 'JKC')
}

async function walletSend() {
    const argAddress = process.argv[4]
    const argAmount = process.argv[5]

    let wallet = JSON.parse(fs.readFileSync(WALLET_PATH))
    let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0)
    if (balance == 0) throw new Error('no funds to send')

    let receiver = new Address(argAddress)
    let amount = parseInt(argAmount)

    let tx = new Transaction()
    if (amount) {
        tx.to(receiver, amount)
        fund(wallet, tx)
    } else {
        tx.from(wallet.utxos)
        tx.change(receiver)
        tx.sign(wallet.privkey)
    }

    await broadcast(tx, true)
    console.log(tx.hash)
}

async function walletSplit() {
    let splits = parseInt(process.argv[4])

    let wallet = JSON.parse(fs.readFileSync(WALLET_PATH))
    let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0)
    if (balance == 0) throw new Error('no funds to split')

    let tx = new Transaction()
    tx.from(wallet.utxos)
    
    // Calculate split amount ensuring each output is above dust threshold
    const splitAmount = Math.max(Math.floor(balance / splits), DUST_AMOUNT)
    
    for (let i = 0; i < splits - 1; i++) {
        tx.to(wallet.address, splitAmount)
    }
    tx.change(wallet.address)
    tx.sign(wallet.privkey)

    await broadcast(tx, true)
    console.log(tx.hash)
}

async function mint(paramAddress, paramContentTypeOrFilename, paramHexData) {
    const argAddress = paramAddress || process.argv[3]
    const argContentTypeOrFilename = paramContentTypeOrFilename || process.argv[4]
    const argHexData = paramHexData || process.argv[5]

    let address = new Address(argAddress)
    let contentType
    let data

    if (fs.existsSync(argContentTypeOrFilename)) {
        contentType = mime.contentType(mime.lookup(argContentTypeOrFilename))
        data = fs.readFileSync(argContentTypeOrFilename)
    } else {
        contentType = argContentTypeOrFilename
        if (!/^[a-fA-F0-9]*$/.test(argHexData)) throw new Error('data must be hex')
        data = Buffer.from(argHexData, 'hex')
    }

    if (data.length == 0) {
        throw new Error('no data to mint')
    }

    if (contentType.length > MAX_SCRIPT_ELEMENT_SIZE) {
        throw new Error('content type too long')
    }

    let wallet = JSON.parse(fs.readFileSync(WALLET_PATH))
    let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0)
    
    if (balance === 0) {
        throw new Error('no funds available')
    }

    let txs = inscribe(wallet, address, contentType, data)
    await broadcastAll(txs, false)
}

function bufferToChunk(b, type) {
    b = Buffer.from(b, type)
    return {
        buf: b.length ? b : undefined,
        len: b.length,
        opcodenum: b.length <= 75 ? b.length : b.length <= 255 ? 76 : 77
    }
}

function numberToChunk(n) {
    if (n <= 16) {
        return {
            buf: undefined,
            len: 0,
            opcodenum: n === 0 ? 0 : 80 + n
        }
    } else if (n < 128) {
        return {
            buf: Buffer.from([n]),
            len: 1,
            opcodenum: 1
        }
    } else {
        return {
            buf: Buffer.from([n % 256, Math.floor(n / 256)]),
            len: 2,
            opcodenum: 2
        }
    }
}

function opcodeToChunk(op) {
    return { opcodenum: op }
}

function inscribe(wallet, address, contentType, data) {
    let txs = []
    let privateKey = new PrivateKey(wallet.privkey)
    let publicKey = privateKey.toPublicKey()

    let parts = []
    while (data.length) {
        let part = data.slice(0, Math.min(MAX_CHUNK_LEN, data.length))
        data = data.slice(part.length)
        parts.push(part)
    }

    let inscription = new Script()
    inscription.chunks.push(bufferToChunk('ord'))
    inscription.chunks.push(numberToChunk(parts.length))
    inscription.chunks.push(bufferToChunk(contentType))
    parts.forEach((part, n) => {
        inscription.chunks.push(numberToChunk(parts.length - n - 1))
        inscription.chunks.push(bufferToChunk(part))
    })

    let p2shInput
    let lastLock
    let lastPartial

    while (inscription.chunks.length) {
        let partial = new Script()

        if (txs.length == 0) {
            partial.chunks.push(inscription.chunks.shift())
        }

        while (partial.toBuffer().length <= MAX_PAYLOAD_LEN && inscription.chunks.length) {
            partial.chunks.push(inscription.chunks.shift())
            partial.chunks.push(inscription.chunks.shift())
        }

        if (partial.toBuffer().length > MAX_PAYLOAD_LEN) {
            inscription.chunks.unshift(partial.chunks.pop())
            inscription.chunks.unshift(partial.chunks.pop())
        }

        let lock = new Script()
        lock.chunks.push(bufferToChunk(publicKey.toBuffer()))
        lock.chunks.push(opcodeToChunk(Opcode.OP_CHECKSIGVERIFY))
        partial.chunks.forEach(() => {
            lock.chunks.push(opcodeToChunk(Opcode.OP_DROP))
        })
        lock.chunks.push(opcodeToChunk(Opcode.OP_TRUE))

        let lockhash = Hash.ripemd160(Hash.sha256(lock.toBuffer()))

        let p2sh = new Script()
        p2sh.chunks.push(opcodeToChunk(Opcode.OP_HASH160))
        p2sh.chunks.push(bufferToChunk(lockhash))
        p2sh.chunks.push(opcodeToChunk(Opcode.OP_EQUAL))

        // Use INSCRIPTION_AMOUNT for P2SH outputs
        let p2shOutput = new Transaction.Output({
            script: p2sh,
            satoshis: INSCRIPTION_AMOUNT
        })

        let tx = new Transaction()
        if (p2shInput) tx.addInput(p2shInput)
        tx.addOutput(p2shOutput)
        fund(wallet, tx)

        if (p2shInput) {
            let signature = Transaction.sighash.sign(tx, privateKey, Signature.SIGHASH_ALL, 0, lastLock)
            let txsignature = Buffer.concat([signature.toBuffer(), Buffer.from([Signature.SIGHASH_ALL])])

            let unlock = new Script()
            unlock.chunks = unlock.chunks.concat(lastPartial.chunks)
            unlock.chunks.push(bufferToChunk(txsignature))
            unlock.chunks.push(bufferToChunk(lastLock.toBuffer()))
            tx.inputs[0].setScript(unlock)
        }

        updateWallet(wallet, tx)
        txs.push(tx)

        p2shInput = new Transaction.Input({
            prevTxId: tx.hash,
            outputIndex: 0,
            output: tx.outputs[0],
            script: ''
        })

        p2shInput.clearSignatures = () => {}
        p2shInput.getSignatures = () => {}

        lastLock = lock
        lastPartial = partial
    }

    let tx = new Transaction()
    tx.addInput(p2shInput)
    
    // Use INSCRIPTION_AMOUNT for final recipient output
    if (address.isPayToScriptHash()) {
        tx.addOutput(Script.buildScriptHashOut(address), INSCRIPTION_AMOUNT)
    } else {
        tx.to(address, INSCRIPTION_AMOUNT)
    }
    
    fund(wallet, tx)

    let signature = Transaction.sighash.sign(tx, privateKey, Signature.SIGHASH_ALL, 0, lastLock)
    let txsignature = Buffer.concat([signature.toBuffer(), Buffer.from([Signature.SIGHASH_ALL])])

    let unlock = new Script()
    unlock.chunks = unlock.chunks.concat(lastPartial.chunks)
    unlock.chunks.push(bufferToChunk(txsignature))
    unlock.chunks.push(bufferToChunk(lastLock.toBuffer()))
    tx.inputs[0].setScript(unlock)

    updateWallet(wallet, tx)
    txs.push(tx)

    return txs
}

function fund(wallet, tx) {
    // Calculate minimum required amount including fees
    const minRequired = tx.outputs.reduce((sum, output) => sum + output.satoshis, 0)
    const estimatedFee = Math.ceil(tx.toBuffer().length * Transaction.FEE_PER_KB / 1000)
    const totalRequired = minRequired + estimatedFee

    tx.change(wallet.address)
    delete tx._fee

    // Sort UTXOs by size to minimize the number of inputs needed
    const sortedUtxos = [...wallet.utxos].sort((a, b) => b.satoshis - a.satoshis)

    let inputAmount = 0
    for (const utxo of sortedUtxos) {
        if (inputAmount >= totalRequired) break

        delete tx._fee
        tx.from(utxo)
        tx.change(wallet.address)
        tx.sign(wallet.privkey)

        inputAmount += utxo.satoshis
    }

    if (inputAmount < totalRequired) {
        throw new Error('not enough funds')
    }

    // Ensure change output is above dust threshold
    const change = inputAmount - minRequired - tx.getFee()
    if (change > 0 && change < DUST_AMOUNT) {
        // If change is below dust, increase fee to consume it
        delete tx._fee
        tx.fee(tx.getFee() + change)
    }
}

function updateWallet(wallet, tx) {
    wallet.utxos = wallet.utxos.filter(utxo => {
        for (const input of tx.inputs) {
            if (input.prevTxId.toString('hex') == utxo.txid && input.outputIndex == utxo.vout) {
                return false
            }
        }
        return true
    })

    tx.outputs.forEach((output, vout) => {
        if (output.script.toAddress().toString() == wallet.address) {
            wallet.utxos.push({
                txid: tx.hash,
                vout,
                script: output.script.toHex(),
                satoshis: output.satoshis
            })
        }
    })
}

async function broadcast(tx, retry) {
    const body = {
        jsonrpc: "1.0",
        id: 0,
        method: "sendrawtransaction",
        params: [tx.toString()]
    }

    const options = {
        auth: {
            username: process.env.NODE_RPC_USER,
            password: process.env.NODE_RPC_PASS
        }
    }

    while (true) {
        try {
            await axios.post(process.env.NODE_RPC_URL, body, options)
            break
        } catch (e) {
            if (!retry) throw e
            let msg = e.response && e.response.data && e.response.data.error && e.response.data.error.message
            if (msg && msg.includes('too-long-mempool-chain')) {
                console.warn('retrying, too-long-mempool-chain')
                await new Promise(resolve => setTimeout(resolve, 1000));
            } else {
                throw e
            }
        }
    }

    let wallet = JSON.parse(fs.readFileSync(WALLET_PATH))
    updateWallet(wallet, tx)
    fs.writeFileSync(WALLET_PATH, JSON.stringify(wallet, 0, 2))
}

async function broadcastAll(txs, retry) {
    for (let i = 0; i < txs.length; i++) {
        console.log(`Broadcasting tx ${i + 1} of ${txs.length}`)

        try {
            await broadcast(txs[i], retry)
        } catch (e) {
            console.log('Broadcast failed:', e?.response?.data)
            if (e?.response?.data?.error?.message?.includes("bad-txns-inputs-spent") || 
                e?.response?.data?.error?.message?.includes("already in block chain")) {
                console.log('Transaction already sent, skipping')
                continue;
            }
            console.log('Saving pending transactions to pending-txs.json')
            console.log('To reattempt broadcast, re-run the command')
            fs.writeFileSync('pending-txs.json', JSON.stringify(txs.slice(i).map(tx => tx.toString())))
            process.exit(1)
        }
    }

    try {
        fs.unlinkSync('pending-txs.json')
    } catch (err) {
        // ignore
    }

    if (txs.length > 1) {
        console.log('Inscription TXID:', txs[1].hash)
    }
}

function chunkToNumber(chunk) {
    if (chunk.opcodenum == 0) return 0
    if (chunk.opcodenum == 1) return chunk.buf[0]
    if (chunk.opcodenum == 2) return chunk.buf[1] * 255 + chunk.buf[0]
    if (chunk.opcodenum > 80 && chunk.opcodenum <= 96) return chunk.opcodenum - 80
    return undefined
}

async function extract(txid) {
    const body = {
        jsonrpc: "1.0",
        id: "extract",
        method: "getrawtransaction",
        params: [txid, true]
    }

    const options = {
        auth: {
            username: process.env.NODE_RPC_USER,
            password: process.env.NODE_RPC_PASS
        }
    }

    let response = await axios.post(process.env.NODE_RPC_URL, body, options)
    let transaction = response.data.result

    let inputs = transaction.vin
    let scriptHex = inputs[0].scriptSig.hex
    let script = Script.fromHex(scriptHex)
    let chunks = script.chunks

    let prefix = chunks.shift().buf.toString('utf-8')
    if (prefix != 'ord') {
        throw new Error('not a valid inscription')
    }

    let pieces = chunkToNumber(chunks.shift())
    let contentType = chunks.shift().buf.toString('utf-8')
    let data = Buffer.alloc(0)
    let remaining = pieces

    while (remaining && chunks.length) {
        let n = chunkToNumber(chunks.shift())

        if (n !== remaining - 1) {
            txid = transaction.vout[0].spent.hash
            response = await axios.post(process.env.NODE_RPC_URL, body, options)
            transaction = response.data.result
            inputs = transaction.vin
            scriptHex = inputs[0].scriptSig.hex
            script = Script.fromHex(scriptHex)
            chunks = script.chunks
            continue
        }

        data = Buffer.concat([data, chunks.shift().buf])
        remaining -= 1
    }

    return {
        contentType,
        data
    }
}

function server() {
    const app = express()
    const port = process.env.SERVER_PORT ? parseInt(process.env.SERVER_PORT) : 3000

    app.get('/tx/:txid', (req, res) => {
        extract(req.params.txid).then(result => {
            res.setHeader('content-type', result.contentType)
            res.send(result.data)
        }).catch(e => res.send(e.message))
    })

    app.listen(port, () => {
        console.log(`Listening on port ${port}`)
        console.log()
        console.log(`Example:`)
        console.log(`http://localhost:${port}/tx/15f3b73df7e5c072becb1d84191843ba080734805addfccb650929719080f62e`)
    })
}

main().catch(e => {
    let reason = e.response && e.response.data && e.response.data.error && e.response.data.error.message
    console.error('Error:', reason ? e.message + ': ' + reason : e.message)
})
