/* 選配的瀏覽器端模型；此檔由建置器複製，不加入 game.json 的 src。 */

const MODEL_URL = 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/2d74ac41a33d7da82f39f7d5720a04c68514a103/gemma-4-E2B-it-web.litertlm';
const CACHE_NAME = 'oncall-litert-gemma-e2b-v1';

let engine;

function reportProgress(onProgress, loaded, total) {
  if (typeof onProgress !== 'function') return;
  if (total > 0) onProgress({loaded, total, ratio: loaded / total});
  else onProgress({loaded, message: '正在下載模型… ' + (loaded / 1048576).toFixed(1) + ' MB'});
}

async function loadModelBlob(onProgress) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(MODEL_URL);
  if (hit) {
    const blob = await hit.blob();
    if (!blob || !blob.size) {
      await cache.delete(MODEL_URL);
    } else {
      reportProgress(onProgress, blob.size, blob.size);
      if (typeof onProgress === 'function') onProgress({message: '從快取載入模型…', loaded: blob.size, total: blob.size, ratio: 1});
      return blob;
    }
  }
  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) throw new Error('模型下載失敗（' + (res.status || '?') + '）');
  const total = Number(res.headers.get('Content-Length')) || 0;
  let loaded = 0;
  const reader = res.body.getReader();
  const stream = new ReadableStream({
    async pull(controller) {
      const {done, value} = await reader.read();
      if (done) {controller.close(); return}
      loaded += value.byteLength;
      reportProgress(onProgress, loaded, total);
      controller.enqueue(value);
    },
    cancel(reason) {return reader.cancel(reason)}
  });
  const blob = await new Response(stream).blob();
  if (!blob.size || (total > 0 && blob.size !== total)) throw new Error('模型下載不完整');
  try {
    await cache.put(MODEL_URL, new Response(blob.slice(), {
      headers: {'Content-Type': 'application/octet-stream', 'Content-Length': String(blob.size)}
    }));
  } catch (error) {
    try {await cache.delete(MODEL_URL)} catch (e) { /* 失敗不留損壞條目 */ }
  }
  return blob;
}

async function model(onProgress) {
  if (!engine) {
    const {Engine, loadLiteRtLm} = await import('https://cdn.jsdelivr.net/npm/@litert-lm/core@0.19.0/+esm');
    self.Module = {locateFile: name => 'https://cdn.jsdelivr.net/npm/@litert-lm/core@0.19.0/wasm/' + name};
    await loadLiteRtLm('https://cdn.jsdelivr.net/npm/@litert-lm/core@0.19.0/wasm/');
    const blob = await loadModelBlob(onProgress);
    engine = await Engine.create({model: blob});
  }
  return engine;
}

self.onmessage = async event => {
  const data = event.data || {};
  const {id} = data;
  if (!Number.isInteger(id)) return;
  let conversation;
  try {
    if (data.prepare) {
      await model(progress => self.postMessage({id, progress}));
      self.postMessage({id, ready: true});
      return;
    }
    if (typeof data.prompt !== 'string') return;
    conversation = await (await model(progress => self.postMessage({id, progress}))).createConversation();
    const response = await conversation.sendMessage(data.prompt);
    self.postMessage({id, text: response.content[0].text});
  } catch (error) {
    self.postMessage({id, error: String(error?.message || error)});
  } finally {
    if (conversation && typeof conversation.delete === 'function') {
      try {await conversation.delete()} catch (e) { /* 釋放失敗不阻斷 */ }
    }
  }
};
