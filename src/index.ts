// Stub entry point — replaced with real routing in the entry-point wiring task.
export default {
  async fetch(): Promise<Response> {
    return new Response('not implemented', { status: 501 });
  },
};
