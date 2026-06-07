declare const Prism: {
  highlightElement: (element: Element) => void;
  highlight: (code: string, grammar: Record<string, unknown>, language: string) => string;
  languages: Record<string, Record<string, unknown>>;
};
