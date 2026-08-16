import { describe, expect, it } from 'vitest'

import { parseDshProcessCandidates } from './process-provider.js'

describe('OS process discovery parsing', () => {
  it('returns only loopback listeners owned by a web-profile DSH process', () => {
    const candidates = parseDshProcessCandidates(
      '25140 node /opt/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --port 0\n25141 node other.js --profile web',
      'LISTEN 0 128 127.0.0.1:12982 0.0.0.0:* users:(("node",pid=25140,fd=18))\nLISTEN 0 128 0.0.0.0:12983 0.0.0.0:* users:(("node",pid=25140,fd=19))',
    )
    expect(candidates).toMatchObject([
      {
        endpoint: { host: '127.0.0.1', port: 12982 },
        pid: 25140,
        source: 'process-scan',
      },
    ])
  })

  it('understands Windows netstat and WMIC-shaped output', () => {
    const candidates = parseDshProcessCandidates(
      'Node,Machine,"node.exe C:\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js --profile web --port 0",25140',
      '  TCP    127.0.0.1:12982    0.0.0.0:0    LISTENING    25140',
    )
    expect(candidates[0]).toMatchObject({ endpoint: { port: 12982 }, pid: 25140 })
  })
})
