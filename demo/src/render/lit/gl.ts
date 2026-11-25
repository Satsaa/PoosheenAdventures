// Minimal WebGL2 helpers with resource accounting (so leaks are measurable).

export const glStats = { textures: 0, framebuffers: 0, buffers: 0 };

export function compile(gl: WebGL2RenderingContext, vs: string, fs: string, name: string): WebGLProgram {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error(`${name} ${type === gl.VERTEX_SHADER ? 'vs' : 'fs'}: ${log}`);
    }
    return s;
  };
  const p = gl.createProgram()!;
  const v = mk(gl.VERTEX_SHADER, vs), f = mk(gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`${name} link: ${gl.getProgramInfoLog(p)}`);
  return p;
}

export interface Prog {
  p: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}

export function program(gl: WebGL2RenderingContext, vs: string, fs: string, name: string): Prog {
  const p = compile(gl, vs, fs, name);
  const u: Record<string, WebGLUniformLocation | null> = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i)!;
    const name2 = info.name.replace(/\[0\]$/, '');
    u[name2] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

export function texture(
  gl: WebGL2RenderingContext, w: number, h: number, opts: { internal?: number; format?: number; type?: number; data?: ArrayBufferView | null; min?: number; mag?: number } = {},
): WebGLTexture {
  const t = gl.createTexture()!;
  glStats.textures++;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, opts.internal ?? gl.RGBA8, w, h, 0, opts.format ?? gl.RGBA, opts.type ?? gl.UNSIGNED_BYTE, opts.data ?? null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, opts.min ?? gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, opts.mag ?? gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

export function delTexture(gl: WebGL2RenderingContext, t: WebGLTexture | null) {
  if (!t) return;
  gl.deleteTexture(t);
  glStats.textures--;
}

export function framebuffer(gl: WebGL2RenderingContext, attachments: WebGLTexture[]): WebGLFramebuffer {
  const f = gl.createFramebuffer()!;
  glStats.framebuffers++;
  gl.bindFramebuffer(gl.FRAMEBUFFER, f);
  attachments.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
  gl.drawBuffers(attachments.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
  const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (st !== gl.FRAMEBUFFER_COMPLETE && !gl.isContextLost()) throw new Error('framebuffer incomplete 0x' + st.toString(16));
  return f;
}

export function delFramebuffer(gl: WebGL2RenderingContext, f: WebGLFramebuffer | null) {
  if (!f) return;
  gl.deleteFramebuffer(f);
  glStats.framebuffers--;
}
