export interface Bm25Input {
  readonly termFrequency: number;
  readonly documentFrequency: number;
  readonly documentCount: number;
  readonly documentLength: number;
  readonly averageDocumentLength: number;
  readonly k1: number;
  readonly b: number;
}

export function bm25Score(input: Bm25Input): number {
  if (
    input.termFrequency <= 0 ||
    input.documentFrequency <= 0 ||
    input.documentCount <= 0 ||
    input.averageDocumentLength <= 0
  ) {
    return 0;
  }

  const idf = Math.log(
    1 + (input.documentCount - input.documentFrequency + 0.5) / (input.documentFrequency + 0.5),
  );
  const lengthNormalization =
    input.k1 * (1 - input.b + input.b * (input.documentLength / input.averageDocumentLength));
  const termFrequencySaturation =
    (input.termFrequency * (input.k1 + 1)) / (input.termFrequency + lengthNormalization);
  return idf * termFrequencySaturation;
}
