export function validateInput(value: any): any;
export class CurrentRequestGuard {
  constructor(input: any);
  input: any;
  phase: string;
  details: any;
  prepared: any;
  report: any;
  probe(body: any, key: string): void;
  observeProbe(status: number, body: any): void;
  prepare(body: any, key: string, persist: (request: any) => Promise<any>): Promise<void>;
  observeBatch(status: number, body: any): void;
  failure(error: any): void;
}
export function requestThroughBrowser(input: any, persist: (request: any) => Promise<any>, engine?: any, captureBrowser?: (pid: number) => Promise<any>): Promise<any>;
