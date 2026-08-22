import React from 'react';
import { ErrorState } from './ErrorState';
import { isChunkLoadError } from '../../utils/chunkReload';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: unknown;
}

/**
 * 라우트 코드 스플리팅 청크 로드 실패의 마지막 방어선 (ticket 2cae7314).
 *
 * main.tsx 의 `vite:preloadError` 핸들러가 먼저 1회 자동 새로고침을 시도한다 —
 * 그걸로 복구되면(새 index.html 이 새 해시를 가리키므로 보통 복구된다) 이 경계까지
 * 오지 않는다. 여기 도달하는 건 새로고침 이후에도 또 실패한 경우뿐이라, 무한
 * 새로고침 대신 사용자가 직접 새로고침을 누르게 안내한다.
 */
export class ChunkLoadErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  componentDidCatch(error: unknown) {
    console.error('Route chunk failed to render:', error);
  }

  render() {
    if (this.state.error !== null) {
      const chunkError = isChunkLoadError(this.state.error);
      return (
        <ErrorState
          title={chunkError ? '새 버전이 배포되었습니다' : '문제가 발생했습니다'}
          message={
            chunkError
              ? '페이지의 새 버전이 배포되어 일부 파일을 불러오지 못했습니다. 새로고침하면 최신 버전을 불러옵니다.'
              : '페이지를 새로고침한 뒤 다시 시도해 주세요.'
          }
          onRetry={() => window.location.reload()}
          retryLabel="새로고침"
        />
      );
    }
    return this.props.children;
  }
}
