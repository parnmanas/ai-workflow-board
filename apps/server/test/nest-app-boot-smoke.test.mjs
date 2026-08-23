// 부팅 스모크 테스트 — 티켓 b209659a.
//
// `nest build`(tsc)는 타입체크만 한다 — NestJS는 DI 그래프를 런타임에
// 해석하므로, 예를 들어 @UseGuards(PermissionGuard)를 쓰는 컨트롤러의
// 모듈이 PermissionGuard 자신의 의존성(AuthGuard)을 등록하는 걸 깜빡해도
// 빌드는 깨끗이 통과하고, 실제로 뭔가가 NestFactory.create(AppModule)을
// 호출하는 순간에야 UnknownDependenciesException이 터진다 — 지금까지는
// 엔지니어가 로컬에서 `node apps/server/dist/main.js`를 수동으로 띄워봐야만
// 발견됐다. 이 파일은 그 확인을 자동화하고 `npm test` 맨 앞에 배치한다
// (같은 AppModule을 부수적으로 부팅하지만 배선 실패를 관련 없어 보이는
// 테스트 안에 파묻는 qa-flows 약 90개 파일보다 먼저 실행되도록).
//
// 이 테스트가 실제로 목표한 버그 클래스를 잡아내는지 검증했다: 기존에
// 정상 동작하던 ResourcesModule의 providers에서 AuthGuard를 일시 제거한 뒤
// 이 부팅이 PermissionGuard/AuthGuard/ResourcesModule을 명시한
// UnknownDependenciesException을 던짐을 확인하고 즉시 파일을 원복했다.
//
// abortOnError:false(helpers/boot.mjs의 bootAppModuleOnly 참고)가 있어야
// NestFactory가 실패 시 스스로 process.exit(1)을 호출해 테스트 워커를
// 조용히 죽이는 대신, 실패가 잡을 수 있는 예외로 드러난다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootAppModuleOnly } from './helpers/boot.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_MODULE_DIST = path.resolve(__dirname, '..', 'dist', 'app.module.js');

test('AppModule이 실제 NestJS DI 컨테이너를 통해 부팅되는가 (tsc가 못 보는 guard/provider 배선 버그 검출)', async () => {
  if (!fs.existsSync(APP_MODULE_DIST)) {
    console.warn('skip: dist/app.module.js가 빌드되지 않음 — `nest build`(또는 먼저 빌드하는 `npm test`)를 실행해야 이 테스트를 검증할 수 있음');
    return;
  }

  let app;
  try {
    app = await bootAppModuleOnly();
  } catch (err) {
    assert.fail(
      `NestFactory.create(AppModule) 부팅 실패 — 어떤 컨트롤러의 @UseGuards()가 지정한 가드의 생성자 ` +
      `의존성이 그 모듈의 providers[]에(직접 등록이든, import한 모듈의 exports[]를 통해서든) 없을 ` +
      `가능성이 높다. 원본 에러:\n${err?.message ?? err}`,
    );
  }
  assert.ok(app, 'NestFactory.create(AppModule)은 app 인스턴스를 반환해야 한다');
  await app.close();
});
