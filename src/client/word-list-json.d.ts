declare module "word-list-json/words.json" {
  const data: { words: string[]; lengths: Record<string, number> };
  export default data;
}
