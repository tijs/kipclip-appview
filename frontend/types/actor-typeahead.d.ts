declare namespace JSX {
  interface IntrinsicElements {
    "actor-typeahead": React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement> & {
        rows?: string;
        host?: string;
      },
      HTMLElement
    >;
  }
}
