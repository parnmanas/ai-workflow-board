// Vite 는 CSS import 를 자산으로 처리하지만 tsc 는 모듈 선언을 요구한다. 이 저장소는
// 스타일을 인라인으로 쓰므로 전역 `*.css` 선언을 두지 않고, 외부 패키지가 들고 오는
// 스타일시트만 여기 하나씩 적는다.
declare module '@xterm/xterm/css/xterm.css';
