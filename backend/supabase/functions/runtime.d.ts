declare const Deno: {
  resolveDns(hostname: string, type: "A"): Promise<string[]>;
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): void;
};
