import { randomBytes, randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { NotificationTransport } from '../server/xcs/admin/notifications'
import {
  createIssuerNotificationMessage,
  sendIssuerNotification,
  type IssuerNotification,
} from '../server/xcs/issuer/notifications'

const token = randomBytes(32).toString('base64url')
const invitation: IssuerNotification = {
  id: randomUUID(),
  kind: 'invitation',
  recipientEmail: 'recipient@example.test',
  organizationName: 'Synthetic school',
  claimUrl: `https://xcs.example.test/recipient/invitations#${token}`,
  message: 'A personal message.\nUn message personnel.',
}
const transport = (
  sendMail = vi.fn().mockResolvedValue({ accepted: [invitation.recipientEmail], rejected: [] }),
): NotificationTransport => ({ sendMail, close: vi.fn() })

describe('issuer notification delivery', () => {
  it('uses an explicit single-recipient envelope and places the private token only in invitation text', () => {
    const message = createIssuerNotificationMessage(invitation)
    expect(message.envelope.to).toEqual([invitation.recipientEmail])
    expect(message.messageId).toBe(`<issuer-${invitation.id}@xcs.test>`)
    expect(message.text).toContain(invitation.claimUrl)
    expect(message.text).toContain(invitation.message)
    expect(JSON.stringify({ ...message, text: undefined })).not.toContain(token)
    expect(message).not.toHaveProperty('html')
    expect(message).not.toHaveProperty('attachments')
  })

  it.each(['issued', 'revoked'] as const)(
    'does not include private links or optional message in %s notifications',
    (kind) => {
      const message = createIssuerNotificationMessage({ ...invitation, kind })
      expect(message.text).not.toContain(token)
      expect(message.text).not.toContain(invitation.message)
      expect(message.text).toContain(kind === 'issued' ? 'a émis' : 'a révoqué')
    },
  )

  it.each([
    { recipientEmail: 'first@example.test,second@example.test' },
    { recipientEmail: 'recipient@example.test\r\nBcc: other@example.test' },
    { organizationName: 'School\r\nBcc: other@example.test' },
    { id: 'id\r\nBcc: other@example.test' },
    { message: 'x'.repeat(2001) },
    { claimUrl: `http://xcs.example.test/recipient/invitations#${token}` },
    { claimUrl: `https://username:password@xcs.example.test/recipient/invitations#${token}` },
    { claimUrl: `https://xcs.example.test/recipient/invitations?token=${token}` },
    { claimUrl: `https://xcs.example.test/recipient/invitations/${token}` },
  ])('rejects malformed notification before SMTP', async (override) => {
    const smtp = transport()
    expect(await sendIssuerNotification(smtp, { ...invitation, ...override })).toEqual({
      status: 'failed',
      errorCode: 'ISSUER_NOTIFICATION_INVALID',
    })
    expect(smtp.sendMail).not.toHaveBeenCalled()
  })

  it('sends once and reports definite SMTP acceptance', async () => {
    const smtp = transport()
    expect(await sendIssuerNotification(smtp, invitation)).toEqual({
      status: 'sent',
      errorCode: null,
    })
    expect(smtp.sendMail).toHaveBeenCalledTimes(1)
  })

  it.each([
    [{ command: 'CONN', syscall: 'connect', code: 'ECONNREFUSED' }, 'failed', 'SMTP_REJECTED'],
    [{ command: 'DATA', responseCode: 550 }, 'failed', 'SMTP_REJECTED'],
    [{ command: 'DATA', code: 'ECONNRESET' }, 'uncertain', 'SMTP_ACCEPTANCE_UNCERTAIN'],
    [{ command: 'CONN', code: 'ETIMEDOUT' }, 'uncertain', 'SMTP_ACCEPTANCE_UNCERTAIN'],
  ])(
    'classifies transport failure without exposing message or retrying',
    async (failure, status, errorCode) => {
      const smtp = transport(
        vi.fn().mockRejectedValue({ ...(failure as object), message: `private ${token}` }),
      )
      const result = await sendIssuerNotification(smtp, invitation)
      expect(result).toEqual({ status, errorCode })
      expect(JSON.stringify(result)).not.toContain(token)
      expect(smtp.sendMail).toHaveBeenCalledTimes(1)
    },
  )

  it.each([{ accepted: [] }, { accepted: ['other@example.test'] }])(
    'marks unexpected recipient acceptance as uncertain',
    async ({ accepted }) => {
      const smtp = transport(vi.fn().mockResolvedValue({ accepted, rejected: [] }))
      expect(await sendIssuerNotification(smtp, invitation)).toEqual({
        status: 'uncertain',
        errorCode: 'SMTP_ACCEPTANCE_UNCERTAIN',
      })
    },
  )

  it('bounds a hanging delivery without an automatic retry', async () => {
    vi.useFakeTimers()
    try {
      const smtp = transport(vi.fn().mockImplementation(() => new Promise(() => {})))
      const delivery = sendIssuerNotification(smtp, invitation)
      await vi.advanceTimersByTimeAsync(60000)
      expect(await delivery).toEqual({
        status: 'uncertain',
        errorCode: 'SMTP_ACCEPTANCE_UNCERTAIN',
      })
      expect(smtp.sendMail).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
