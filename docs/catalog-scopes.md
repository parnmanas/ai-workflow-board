# Catalogs in the shared instance

카탈로그에는 사용자가 고르는 Account/Scope 또는 소유 계정 목록이 없다.
Resources, Credentials, Functions, Skills는 하나의 설치에서 사용한다.
로그인과 기능별 관리 권한, credential 비밀값 열람 권한은 유지한다.

내부적으로 기존 Global 정의(`account_id IS NULL`)와 사용자 정의(단일 실행
키)를 구분하는 저장 방식은 남아 있다. 같은 Function key/Skill slug는 사용자
정의가 기본 정의를 덮어쓴다. 이는 사용자·업무를 분리하는 소유권 경계가 아니다.
기존 ID 참조는 그대로 유지하고, 이름이 같다는 이유로 credential이나 resource를
합치거나 지우지 않는다.

새 항목의 내부 귀속은 화면에서 자동으로 정한다. 수정·삭제는 기존 객체 ID로
처리한다. 계정 생성·삭제·멤버 배정과 별도 실행 계정 선택은 제공하지 않는다.
설정은 `/settings/defaults`, 로그인 사용자 관리는 `/settings/users`에 있다.

기존 계정 데이터 통합, 보존 범위와 남아 있는 내부 필드의 제한은
[shared work](ownership.md)를 따른다. 과거의 다중 계정 모델을 새 화면이나
접근 권한 검사로 되살리지 않는다.
