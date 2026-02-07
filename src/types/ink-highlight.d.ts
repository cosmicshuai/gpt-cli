declare module 'ink-highlight' {
  import * as React from 'react';
  
  interface HighlightProps {
    code: string;
    language?: string;
    theme?: 'dark' | 'light';
    ignoreIllegals?: boolean;
    languageSubset?: string[];
  }
  
  const Highlight: React.FC<HighlightProps>;
  export { Highlight };
}