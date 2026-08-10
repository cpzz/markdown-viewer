declare module "katex/contrib/auto-render" {
  interface AutoRenderDelimiter {
    left: string;
    right: string;
    display: boolean;
  }

  interface AutoRenderOptions {
    delimiters?: AutoRenderDelimiter[];
    ignoredTags?: string[];
    ignoredClasses?: string[];
    throwOnError?: boolean;
    errorCallback?: (msg: string, err: Error) => void;
    preProcess?: (math: string) => string;
    macros?: Record<string, string>;
    trust?: boolean;
    strict?: boolean | "ignore" | "warn" | "error" | ((errorCode: string, errorMsg: string, token: string) => "ignore" | "warn" | "error");
  }

  export default function renderMathInElement(element: Element, options?: AutoRenderOptions): void;
}
