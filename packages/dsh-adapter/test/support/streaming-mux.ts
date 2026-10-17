import { WebSocketServer, type WebSocket } from 'ws'

/** Real loopback framing with synthetic upstream data; never uses a user DSH. */
export async function streamingMux(): Promise<{
  readonly port: number
  readonly opens: () => number
  readonly item: (stream: number, value: unknown) => void
  readonly close: () => Promise<void>
}> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const streams: { socket: WebSocket; id: string }[] = []
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const bytes = Array.isArray(raw)
        ? Buffer.concat(raw)
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw)
          : raw
      const frame = JSON.parse(bytes.toString('utf8')) as { type: string; streamId: string }
      if (frame.type === 'open') streams.push({ socket, id: frame.streamId })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('No loopback address')
  return {
    port: address.port,
    opens: () => streams.length,
    item: (index, value) => {
      const stream = streams[index]
      if (stream === undefined) throw new Error('Follow stream has not opened')
      stream.socket.send(JSON.stringify({ type: 'item', streamId: stream.id, value }))
    },
    close: () => {
      for (const socket of server.clients) socket.terminate()
      return new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}
