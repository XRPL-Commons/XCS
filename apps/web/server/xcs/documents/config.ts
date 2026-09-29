import { isAbsolute } from 'node:path'
import { serverSecret } from '../secrets'
import type { PrivateDocumentStorageConfig } from './storage'

const s3Bucket = /^(?!-)(?!.*\.\.)(?!.*-$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const s3Region = /^[a-z0-9][a-z0-9-]{0,62}$/
const s3Prefix = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,62}\/)?$/

export function loadPrivateDocumentStorageConfig(
  env: NodeJS.ProcessEnv,
): PrivateDocumentStorageConfig {
  const driver = env.XCS_DOCUMENT_STORAGE_DRIVER
  if (driver === 'filesystem') {
    const directory = env.XCS_DOCUMENT_FILESYSTEM_DIRECTORY ?? ''
    if (!isAbsolute(directory)) throw new Error('DOCUMENT_FILESYSTEM_DIRECTORY_REQUIRED')
    if (env.NODE_ENV === 'production' && env.XCS_DOCUMENT_FILESYSTEM_LOCAL !== '1')
      throw new Error('DOCUMENT_FILESYSTEM_LOCAL_ONLY')
    return { driver, directory }
  }
  if (driver === 's3') {
    const bucket = env.XCS_DOCUMENT_S3_BUCKET ?? '',
      region = env.XCS_DOCUMENT_S3_REGION ?? '',
      endpointValue = env.XCS_DOCUMENT_S3_ENDPOINT ?? '',
      prefix = env.XCS_DOCUMENT_S3_PREFIX ?? '',
      privateBucketConfirmed = env.XCS_DOCUMENT_S3_PRIVATE_BUCKET === '1',
      accessKeyId = serverSecret(env, 'XCS_DOCUMENT_S3_ACCESS_KEY_ID'),
      secretAccessKey = serverSecret(env, 'XCS_DOCUMENT_S3_SECRET_ACCESS_KEY')
    let endpoint: URL
    try {
      endpoint = new URL(endpointValue)
    } catch {
      throw new Error('DOCUMENT_S3_CONFIGURATION_INVALID')
    }
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.origin !== endpointValue ||
      endpoint.username ||
      endpoint.password ||
      !s3Bucket.test(bucket) ||
      !s3Region.test(region) ||
      !s3Prefix.test(prefix) ||
      !privateBucketConfirmed ||
      !/^[A-Za-z0-9/+=._-]{8,256}$/.test(accessKeyId) ||
      Buffer.byteLength(secretAccessKey) < 16 ||
      Buffer.byteLength(secretAccessKey) > 1024
    )
      throw new Error('DOCUMENT_S3_CONFIGURATION_INVALID')
    return {
      driver,
      bucket,
      region,
      endpoint: endpoint.origin,
      prefix,
      privateBucketConfirmed,
      accessKeyId,
      secretAccessKey,
    }
  }
  throw new Error('DOCUMENT_STORAGE_DRIVER_REQUIRED')
}
