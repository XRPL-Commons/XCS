import { createServer, type Socket } from 'node:net'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifySmtpFailure,
  createLocalSmtpTransport,
  createNotificationMessage,
  isNotificationEmail,
  processNextNotification,
  type ClaimedNotification,
  type NotificationRepository,
  type NotificationTransport,
} from '../server/xcs/admin/notifications'

const notification: ClaimedNotification = {
  id: '84b066bb-aa8d-40a6-b37d-3a3d7cf25485',
  attemptId: '898709b2-32e9-4e6f-b76d-c0e8c86a1819',
  decisionId: '4bf585ef-6af5-4f9d-a565-abf70265a7ed',
  recipientEmail: 'responsible@example.test',
  organizationName: 'Example organization',
  role: 'verifier',
  status: 'approved',
}

function setup() {
  const repository = {
    recoverStale: vi.fn<NotificationRepository['recoverStale']>().mockResolvedValue(),
    claim: vi
      .fn<NotificationRepository['claim']>()
      .mockResolvedValue({ kind: 'claimed', notification }),
    finish: vi.fn<NotificationRepository['finish']>().mockResolvedValue(),
  }
  const transport = {
    sendMail: vi
      .fn<NotificationTransport['sendMail']>()
      .mockResolvedValue({ accepted: [notification.recipientEmail], rejected: [] }),
    close: vi.fn(),
  }
  return { repository, transport }
}

afterEach(() => vi.useRealTimers())

describe('admin notification delivery', () => {
  it('delivers a bilingual decision with exactly one explicit envelope recipient', async () => {
    const { repository, transport } = setup()
    expect(await processNextNotification(repository, transport)).toBe('sent')
    const message = transport.sendMail.mock.calls[0]![0]
    expect(message.to).toEqual({ name: '', address: notification.recipientEmail })
    expect(message.envelope.to).toEqual([notification.recipientEmail])
    expect(message.text).toContain('now approved')
    expect(message.text).toContain('maintenant approuvé')
    expect(message.text).toContain(notification.decisionId)
    expect(repository.finish).toHaveBeenCalledWith(notification, 'sent', null)
    expect(repository.recoverStale).toHaveBeenCalledOnce()
  })

  it.each(['idle', 'blocked'] as const)('does not send a %s notification', async (kind) => {
    const { repository, transport } = setup()
    repository.claim.mockResolvedValue({ kind })
    expect(await processNextNotification(repository, transport)).toBe(kind)
    expect(transport.sendMail).not.toHaveBeenCalled()
    expect(repository.finish).not.toHaveBeenCalled()
  })

  it('records a definitive connection failure without retaining SMTP error details', async () => {
    const { repository, transport } = setup()
    transport.sendMail.mockRejectedValue({
      command: 'CONN',
      syscall: 'connect',
      message: 'sensitive detail',
    })
    expect(await processNextNotification(repository, transport)).toBe('failed')
    expect(repository.finish).toHaveBeenCalledWith(notification, 'failed', 'SMTP_REJECTED')
    expect(JSON.stringify(repository.finish.mock.calls)).not.toContain('sensitive detail')
  })

  it('records an ambiguous DATA failure as uncertain', async () => {
    const { repository, transport } = setup()
    transport.sendMail.mockRejectedValue({ command: 'DATA', code: 'ETIMEDOUT' })
    expect(await processNextNotification(repository, transport)).toBe('uncertain')
    expect(repository.finish).toHaveBeenCalledWith(
      notification,
      'uncertain',
      'SMTP_ACCEPTANCE_UNCERTAIN',
    )
  })

  it('bounds the total SMTP attempt and never retries after an ambiguous deadline', async () => {
    vi.useFakeTimers()
    const { repository, transport } = setup()
    transport.sendMail.mockReturnValue(new Promise(() => {}))
    const result = processNextNotification(repository, transport)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await result).toBe('uncertain')
    expect(transport.sendMail).toHaveBeenCalledOnce()
    expect(repository.finish).toHaveBeenCalledWith(
      notification,
      'uncertain',
      'SMTP_ACCEPTANCE_UNCERTAIN',
    )
  })

  it('does not misclassify a database failure after successful SMTP as a resendable failure', async () => {
    const { repository, transport } = setup()
    repository.finish.mockRejectedValue(new Error('Database unavailable'))
    await expect(processNextNotification(repository, transport)).rejects.toThrow(
      'Database unavailable',
    )
    expect(repository.finish).toHaveBeenCalledOnce()
    expect(repository.finish).toHaveBeenCalledWith(notification, 'sent', null)
  })

  it('requires positive acceptance evidence', async () => {
    const { repository, transport } = setup()
    transport.sendMail.mockResolvedValue({ accepted: [], rejected: [] })
    expect(await processNextNotification(repository, transport)).toBe('uncertain')
  })

  it('keeps the logical Message-ID stable across explicit attempts', () => {
    expect(createNotificationMessage(notification).messageId).toBe(
      createNotificationMessage({ ...notification, attemptId: 'another-attempt' }).messageId,
    )
  })
})

describe('SMTP boundaries', () => {
  it.each([
    [{ command: 'CONN', code: 'ESOCKET', syscall: 'connect' }, 'failed'],
    [{ command: 'CONN', code: 'EDNS' }, 'failed'],
    [{ command: 'CONN', code: 'ECONNECTION' }, 'uncertain'],
    [{ command: 'CONN', code: 'ETIMEDOUT' }, 'uncertain'],
    [{ command: 'RCPT TO', responseCode: 550 }, 'failed'],
    [{ command: 'DATA', responseCode: 451 }, 'failed'],
    [{ command: 'DATA', code: 'ECONNRESET' }, 'uncertain'],
    [{ code: 'ETIMEDOUT' }, 'uncertain'],
    [new Error('unknown'), 'uncertain'],
  ])('classifies %j conservatively as %s', (error, expected) => {
    expect(classifySmtpFailure(error)).toBe(expected)
  })

  it.each([
    'a@example.test, b@example.test',
    'Name <a@example.test>',
    'a@example.test\r\nBcc:b@example.test',
    '',
    null,
  ])('rejects a recipient that is not a single mailbox: %j', (email) => {
    expect(isNotificationEmail(email)).toBe(false)
  })

  it('accepts a plain verified mailbox', () => {
    expect(isNotificationEmail('responsible+test@example.test')).toBe(true)
  })

  it.each(['smtp.example.com', 'https://mailpit', '127.0.0.2'])(
    'rejects external SMTP host %s',
    (host) => {
      expect(() => createLocalSmtpTransport({ XCS_SMTP_HOST: host })).toThrow('local Mailpit')
    },
  )

  it.each(['0', '-1', '65536', '1025x', '1.5', ''])('rejects invalid SMTP port %s', (port) => {
    expect(() => createLocalSmtpTransport({ XCS_SMTP_PORT: port })).toThrow('valid port')
  })

  it.each(['127.0.0.1', 'localhost', 'mailpit'])('accepts local Mailpit host %s', (host) => {
    const transport = createLocalSmtpTransport({ XCS_SMTP_HOST: host })
    expect(transport.sendMail).toBeTypeOf('function')
    transport.close()
  })
})

// Exercise Nodemailer's actual SMTP protocol and error shape, without an external service.
async function localSmtpServer(accept: boolean) {
  const sockets = new Set<Socket>()
  const messages: string[] = []
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.write('220 local.test ESMTP\r\n')
    let buffer = ''
    let inData = false
    let content = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let newline: number
      while ((newline = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 2)
        if (inData) {
          if (line === '.') {
            messages.push(content)
            inData = false
            if (accept) socket.write('250 accepted\r\n')
            else socket.destroy()
          } else content += `${line}\n`
        } else if (line.startsWith('EHLO') || line.startsWith('HELO')) {
          socket.write('250 local.test\r\n')
        } else if (line === 'DATA') {
          inData = true
          socket.write('354 send data\r\n')
        } else if (line === 'QUIT') socket.end('221 bye\r\n')
        else socket.write('250 OK\r\n')
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('SMTP test server has no port')
  return {
    port: address.port,
    messages,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
}

describe('actual local SMTP transport', () => {
  it('receives the decision and persists success after the SMTP acknowledgement', async () => {
    const server = await localSmtpServer(true)
    const transport = createLocalSmtpTransport({ XCS_SMTP_PORT: String(server.port) })
    try {
      const { repository } = setup()
      expect(await processNextNotification(repository, transport)).toBe('sent')
      expect(server.messages).toHaveLength(1)
      expect(server.messages[0]).toContain('To: responsible@example.test')
      expect(server.messages[0]).toContain(
        `Message-ID: <admin-decision-${notification.decisionId}@xcs.test>`,
      )
      expect(repository.finish).toHaveBeenCalledWith(notification, 'sent', null)
    } finally {
      transport.close()
      await server.close()
    }
  })

  it('keeps acceptance uncertain when the connection breaks after receiving DATA', async () => {
    const server = await localSmtpServer(false)
    const transport = createLocalSmtpTransport({ XCS_SMTP_PORT: String(server.port) })
    try {
      const { repository } = setup()
      expect(await processNextNotification(repository, transport)).toBe('uncertain')
      expect(server.messages).toHaveLength(1)
      expect(repository.finish).toHaveBeenCalledWith(
        notification,
        'uncertain',
        'SMTP_ACCEPTANCE_UNCERTAIN',
      )
    } finally {
      transport.close()
      await server.close()
    }
  })
})
