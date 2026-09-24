export default defineEventHandler((event) => dispatch(event, 'GET', '/internal/metrics'))
