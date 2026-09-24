// Copied from packages/core/src/tr46.d.ts at 54c3486; keep in sync by hand (see CONTRIBUTING.md).
declare module 'tr46' {
  interface ToASCIIOptions {
    checkBidi?: boolean
    checkHyphens?: boolean
    checkJoiners?: boolean
    ignoreInvalidPunycode?: boolean
    transitionalProcessing?: boolean
    useSTD3ASCIIRules?: boolean
    verifyDNSLength?: boolean
  }

  interface Tr46 {
    toASCII(domainName: string, options?: ToASCIIOptions): string | null
  }

  const tr46: Tr46
  export default tr46
}
