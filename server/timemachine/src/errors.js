// Every refusal the Time Machine makes: a stable .code plus a readable message.
export class TimeMachineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TimeMachineError";
    this.code = code;
  }
}
