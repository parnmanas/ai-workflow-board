# ChatGPT와 Claude에서 AWB 연결하기

AWB의 **설정 → MCP 연결**에서 이 인스턴스의 서버 주소를 복사하세요. 주소는 `https://<AWB 도메인>/mcp` 형태입니다. 두 앱 모두 AWB에서 쓰는 Google 계정으로 연결할 수 있습니다.

## ChatGPT 웹

1. **Plugins → + → Add custom MCP server**를 여세요.
2. 이름에 `AWB`를 입력하고 **Server URL**에 복사한 주소를 붙여 넣으세요. 인증 방식은 **OAuth**, 클라이언트 등록 방식은 **Dynamic Client Registration (DCR)**을 선택하세요. AWB가 클라이언트를 자동 등록합니다.
3. 안내를 확인하고 플러그인을 생성한 뒤 설치하세요. **Connect**를 누르면 Google 로그인이 열립니다. AWB에서 계정과 읽을 수 있는 데이터를 확인하고 **조회 허용**을 누르세요.
4. 새 대화에서 AWB를 선택하거나 `@AWB`를 입력한 뒤 “내 AWB 프로젝트 목록을 보여줘”라고 물어보세요.

Business에서는 소유자나 관리자가 커스텀 서버를 등록할 수 있습니다. Enterprise·Edu에서는 관리자가 지정한 구성원도 등록할 수 있습니다. 메뉴가 보이지 않으면 요금제와 조직의 플러그인 생성 권한을 확인하세요. [OpenAI의 연결 및 이용 조건](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)

## Claude 웹·데스크톱

1. **Connectors → Add → Add custom connector**를 여세요. Team·Enterprise에서는 조직 소유자 또는 권한 있는 관리자가 **Organization settings → Connectors → Add → Custom**에서 먼저 등록합니다.
2. 이름에 `AWB`를 입력하고 서버 주소를 붙여 넣으세요. **Continue**가 보이면 누르세요.
3. 인증은 **Sign in now**, OAuth 클라이언트는 **Register automatically**를 선택하세요. 한 화면에 표시되는 버전에서는 **Advanced**에서 OAuth 설정을 찾을 수 있습니다.
4. **Add → Connect**를 누르세요. 본인의 Google 계정으로 로그인하고 AWB에서 연결할 계정을 선택한 뒤 **조회 허용**을 누르세요. 새 대화의 **+** 메뉴에서 AWB를 켜고 “내 AWB 티켓을 보여줘”라고 물어보세요. [Claude의 커스텀 커넥터 안내](https://claude.com/docs/connectors/custom/add-unlisted)

## 공유 범위와 연결 해제

앱은 승인한 AWB 계정의 프로젝트와 티켓을 조회합니다. 상세 조회에는 프로젝트의 저장소·작업 지침과 티켓의 댓글이 포함됩니다. 각 앱은 자기 연결에 발급된 AWB 토큰을 사용합니다. Google 비밀번호는 Google 로그인 화면에서만 입력하세요.

AWB **설정 → MCP 연결 → 연결된 앱 → 연결 해제**에서 해당 앱의 접근을 즉시 종료할 수 있습니다. 연결 갱신을 허용한 경우에도 30일이 지나면 새 승인이 필요합니다.

## 다른 MCP 클라이언트와 자체 호스팅

다른 OAuth 앱도 Google 로그인을 사용할 수 있습니다. 관리자가 신뢰할 앱의 정확한 HTTPS 콜백 URI를 서버 환경 변수 `MCP_OAUTH_REDIRECT_URIS`에 쉼표로 구분해 등록하고 AWB를 다시 시작하세요. 클라이언트에서 **OAuth → 자동 등록(DCR)**을 선택하면 AWB 동의 화면에 콜백의 도메인이 표시됩니다.

사용자 지정 HTTP 헤더를 지원하는 MCP 클라이언트는 같은 주소에 **Streamable HTTP**로 연결할 수 있습니다. AWB **설정 → API Keys**에서 읽기 전용 키를 발급하고 클라이언트의 보안 설정에 `Authorization: Bearer <AWB_API_KEY>`를 넣으세요. 키 발급에는 API 키 관리 권한이 필요합니다.

자체 호스팅 관리자는 AWB의 공개 HTTPS 주소와 **관리 → System Settings → Google OAuth**를 확인하세요. Google Cloud의 웹 애플리케이션에 등록할 승인된 리디렉션 URI는 `https://<AWB 도메인>/api/auth/oauth/google/callback`입니다. ChatGPT와 Claude에는 설치별 공개 MCP 서버 주소만 입력합니다. 리버스 프록시는 `/mcp`, `/.well-known/`, `/api/auth/oauth/google/`, `/api/mcp-oauth/`를 같은 AWB 서버로 전달해야 합니다. [MCP 인증 사양](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
