declare module 'rss-parser' {
  interface Item {
    title?: string;
    link?: string;
    guid?: string;
    isoDate?: string;
    contentSnippet?: string;
  }
  interface Feed {
    title?: string;
    items: Item[];
  }
  interface ParserOptions {
    timeout?: number;
    headers?: Record<string, string>;
  }
  class Parser<T = unknown> {
    constructor(options?: ParserOptions);
    parseURL(url: string): Promise<Feed>;
    parseString(xml: string): Promise<Feed>;
  }
  export default Parser;
}
