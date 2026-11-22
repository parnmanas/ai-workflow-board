import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';

// Only this static bootstrap is a navigable URL. Private HTML arrives over a one-use
// channel after the authenticated parent opens a registered application.
const bootstrap = `<!doctype html><meta charset="utf-8"><script>
addEventListener('message', function start(event) {
  if (parent === window || event.source !== parent || event.origin !== new URL(location.href).origin ||
      event.data?.type !== 'awb-web-app' || typeof event.data.html !== 'string' || event.ports.length !== 1) return;
  removeEventListener('message', start);
  const port = event.ports[0], pending = new Map();
  let sequence = 0;
  port.onmessage = ({data}) => {
    const reply = pending.get(data?.id);
    if (!reply) return;
    pending.delete(data.id);
    reply(data);
  };
  const appOrigin = 'https://session-app.invalid';
  const source = new DOMParser().parseFromString(event.data.html, 'text/html');
  source.querySelectorAll('base').forEach(node => node.remove());
  const base = source.createElement('base');
  base.href = appOrigin + '/';
  source.head.prepend(base);
  const html = '<!doctype html>' + source.documentElement.outerHTML;
  document.open();
  window.fetch = async (resource, init) => {
    const request = new Request(resource instanceof Request ? resource : new URL(resource, appOrigin), init);
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.origin !== appOrigin ||
        url.search || url.hash || pending.size >= 4) throw new TypeError('Unsupported application request');
    const body = await request.text();
    if (body.length > 32768) throw new TypeError('Request too large');
    request.signal.throwIfAborted();
    const id = ++sequence;
    const result = await new Promise((resolve, reject) => {
      const stop = () => { cleanup(); reject(new TypeError('Application request interrupted')); };
      const timer = setTimeout(stop, 12000);
      const cleanup = () => { clearTimeout(timer); pending.delete(id); request.signal.removeEventListener('abort', stop); };
      pending.set(id, reply => { cleanup(); resolve(reply); });
      request.signal.addEventListener('abort', stop, {once:true});
      port.postMessage({id, path:url.pathname, body});
    });
    if (result.error) throw new TypeError(result.error);
    return new Response(result.body, {status:result.status, headers:{'Content-Type':'application/json'}});
  };
  document.write(html);
  document.close();
});
</script>`;

@Controller('api/agent-sessions')
export class WebAppFrameController {
  @Get('web-app-frame')
  frame(@Res() res: Response) {
    res.set({
      'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; worker-src 'none'; base-uri https://session-app.invalid; form-action 'none'; frame-ancestors 'self'",
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    return res.type('html').send(bootstrap);
  }
}
