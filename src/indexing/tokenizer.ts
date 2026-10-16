export interface Token {
  readonly term: string;
  readonly position: number;
}

const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

export function tokenize(value: string, maxTokenLength: number): readonly Token[] {
  const tokens: Token[] = [];
  let position = 0;
  for (const match of value.normalize('NFKC').toLocaleLowerCase('en-US').matchAll(TOKEN_PATTERN)) {
    const term = match[0];
    if (term.length <= maxTokenLength) {
      tokens.push({ term, position });
    }
    position += 1;
  }
  return tokens;
}
