export default defineEventHandler((event) => dispatch(event, 'POST', '/v1/payloads/:locator'))
