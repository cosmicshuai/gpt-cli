declare module 'ink-highlight' {
  import * as React from 'react';
  
  interface HighlightProps {
    code: string;
    language?: string;
    theme?: 'dark' | 'light';
  }
  
  const Highlight: React.FC<HighlightProps>;
  export default Highlight;
}