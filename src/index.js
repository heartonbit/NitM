export default {
  fetch() {
    return new Response("NitM is running.", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
