# ChatGPT와 Claude에서 AWB 연결하기

AWB의 **설정 → MCP 연결**에서 이 인스턴스의 서버 주소를 복사하세요. 주소는 `https://<AWB 도메인>/mcp` 형태입니다. 두 앱 모두 AWB에서 쓰는 Google 계정으로 연결할 수 있습니다.

## ChatGPT 웹

1. **Plugins → + → Add custom MCP server**를 여세요.
2. 이름에 `AWB`를 입력하고 **Server URL**에 복사한 주소를 붙여 넣으세요. 인증 방식은 **OAuth**, 클라이언트 등록 방식은 **Dynamic Client Registration (DCR)**을 선택하세요. AWB가 클라이언트를 자동 등록합니다.
3. 안내를 확인하고 플러그인을 생성한 뒤 설치하세요. **Connect**를 누르면 Google 로그인이 열립니다. AWB에서 사용할 계정을 확인하고 **작업 권한 허용**을 누르세요.
4. 새 대화에서 AWB를 선택하거나 `@AWB`를 입력한 뒤 “내 AWB 프로젝트 목록을 보여줘”라고 물어보세요.

ChatGPT에서 세션에 메시지를 보내려면 Business, Enterprise 또는 Edu 요금제가 필요합니다. Pro는 조회 작업을 지원합니다. Business에서는 소유자나 관리자가 커스텀 서버를 등록할 수 있고, Enterprise·Edu에서는 관리자가 지정한 구성원도 등록할 수 있습니다. 이미 게시한 AWB 앱에 세션 도구가 보이지 않으면 워크스페이스 관리자가 앱 설정의 **Refresh**로 도구 목록을 새로 고치고 세션 작업을 활성화하세요. [OpenAI의 연결 및 이용 조건](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)

## Claude 웹·데스크톱

1. **Connectors → Add → Add custom connector**를 여세요. Team·Enterprise에서는 조직 소유자 또는 권한 있는 관리자가 **Organization settings → Connectors → Add → Custom**에서 먼저 등록합니다.
2. 이름에 `AWB`를 입력하고 서버 주소를 붙여 넣으세요. **Continue**가 보이면 누르세요.
3. 인증은 **Sign in now**, OAuth 클라이언트는 **Register automatically**를 선택하세요. 한 화면에 표시되는 버전에서는 **Advanced**에서 OAuth 설정을 찾을 수 있습니다.
4. **Add → Connect**를 누르세요. 본인의 Google 계정으로 로그인하고 AWB에서 연결할 계정을 선택한 뒤 **작업 권한 허용**을 누르세요. 새 대화의 **+** 메뉴에서 AWB를 켜고 “내 AWB 티켓을 보여줘”라고 물어보세요. [Claude의 커스텀 커넥터 안내](https://claude.com/docs/connectors/custom/add-unlisted)

## 호스트 세션과 대화하기

새 대화에서 AWB를 선택하고 “실행 중인 Codex 세션을 보여줘. 내가 고른 세션에 빌드 결과를 물어보고 답을 읽어줘”라고 요청하세요. 로그인한 사용자에게 `agent_sessions.use` 권한이 있어야 합니다.

1. `list_sessions`에 `running_only: true`를 주면 실행 중인 세션의 제목과 주소를 찾을 수 있습니다. 새 세션을 만들 때는 `list_session_hosts`에서 호스트를 고른 뒤 `open_session`에 호스트·CLI·작업 폴더를 넘기세요.
2. `send_session_message`에 세션 주소와 메시지를 보내세요. `submitted`는 호스트에 전달했다는 뜻입니다. 세션이 작업 중이면 해당 CLI가 메시지를 현재 작업에 반영하거나 대기열에 둡니다.
3. `get_session_messages`로 같은 세션의 답변을 읽으세요. 처리 중이면 잠시 후 다시 조회하세요. 후속 질문에는 같은 주소를 사용하고 이전 대화는 `next_before`로 읽을 수 있습니다.

호스트 에이전트에서 개인 앱 연결도 보이는 경우, 에이전트는 조회와 변경 모두 호스트의 `awb`를 우선합니다. 이 연결에 문제가 생기면 알리고, 사용자가 개인 앱을 명시적으로 선택할 때 그 연결을 사용합니다.

## 공유 범위와 연결 해제

**작업 권한 허용**(`awb.manage`)은 선택한 계정에서 기존 MCP 도구 목록을 제공합니다. 티켓·프로젝트 변경, 채팅, 세션 실행은 로그인한 사용자의 AWB 권한을 따릅니다. 배정된 에이전트나 오퍼레이터 신원이 필요한 작업은 해당 세션에서 처리합니다. 호스트 승인은 AWB의 기존 승인 절차를 따릅니다.

이전에 **조회 허용**(`awb.read`)으로 연결한 앱은 계속 프로젝트·티켓 목록과 상세만 읽습니다. 세션과 대화하려면 앱을 다시 연결해 **작업 권한 허용**을 선택하세요. 각 연결의 권한은 AWB **설정 → MCP 연결 → 연결된 앱**에서 확인할 수 있습니다.

API 키를 관리하는 사용자는 앱이 `awb.keys`도 요청한 경우 동의 화면에서 키 발급과 관리를 따로 허용할 수 있습니다. 앱을 통해 발급한 독립 API 키는 **설정 → API Keys**에서 개별 폐기합니다.

AWB **설정 → MCP 연결 → 연결된 앱 → 연결 해제**에서 해당 앱의 접근을 즉시 종료할 수 있습니다. 연결 갱신을 허용한 경우에도 30일이 지나면 새 승인이 필요합니다.

## 다른 MCP 클라이언트와 자체 호스팅

다른 OAuth 앱도 Google 로그인을 사용할 수 있습니다. 관리자가 신뢰할 앱의 정확한 HTTPS 콜백 URI를 서버 환경 변수 `MCP_OAUTH_REDIRECT_URIS`에 쉼표로 구분해 등록하고 AWB를 다시 시작하세요. 클라이언트에서 **OAuth → 자동 등록(DCR)**을 선택하면 AWB 동의 화면에 콜백의 도메인이 표시됩니다.

사용자 지정 HTTP 헤더를 지원하는 MCP 클라이언트는 같은 주소에 **Streamable HTTP**로 연결할 수 있습니다. AWB **설정 → API Keys**에서 읽기 전용 키를 발급하고 클라이언트의 보안 설정에 `Authorization: Bearer <AWB_API_KEY>`를 넣으세요. 키 발급에는 API 키 관리 권한이 필요합니다.

자체 호스팅 관리자는 AWB의 공개 HTTPS 주소와 **관리 → System Settings → Google OAuth**를 확인하세요. Google Cloud의 웹 애플리케이션에 등록할 승인된 리디렉션 URI는 `https://<AWB 도메인>/api/auth/oauth/google/callback`입니다. ChatGPT와 Claude에는 설치별 공개 MCP 서버 주소만 입력합니다. 리버스 프록시는 `/mcp`, `/.well-known/`, `/api/auth/oauth/google/`, `/api/mcp-oauth/`를 같은 AWB 서버로 전달해야 합니다. [MCP 인증 사양](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
