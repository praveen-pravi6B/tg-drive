// GramJS expects Node-style globals in the browser.
import { Buffer } from 'buffer'
import process from 'process'

if (!globalThis.Buffer) {
  globalThis.Buffer = Buffer
}

if (!globalThis.process) {
  globalThis.process = process
}
