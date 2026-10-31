export function sha256File(filePath: string): string;

export function assertSha256(input: { actualHex: string; expected: unknown; label: string }): string;
