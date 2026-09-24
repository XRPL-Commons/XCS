export default defineEventHandler((event) => dispatch(event, 'GET', '/v1/networks/:network/stats'))
