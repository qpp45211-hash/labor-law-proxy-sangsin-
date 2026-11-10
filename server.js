require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static(__dirname));

const OC = process.env.LAW_OC;

// 법제처가 JSON 대신 보내는 HTML 오류 페이지에서 사람이 읽을 수 있는 문장만 뽑아내기
function readableFromHtml(text) {
  return String(text || '')
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// 법제처 목록 API 한 페이지 가져오기 (결과가 1건이면 배열이 아닌 객체로 오는 경우까지 처리)
async function fetchLawListPage(baseUrl, page) {
  const response = await fetch(`${baseUrl}&page=${page}`, {
    headers: { 'Referer': 'https://www.law.go.kr/' }
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (parseErr) {
    throw new Error(`법제처가 JSON이 아닌 응답을 보냈습니다 (${page}페이지, HTTP ${response.status}): ${readableFromHtml(text) || '내용 없음'}`);
  }
  const ls = data.LawSearch || {};
  let arr = ls.law;
  if (!Array.isArray(arr)) arr = arr ? [arr] : [];
  return { total: Number(ls.totalCnt) || arr.length, laws: arr };
}

// 일시적인 오류에 대비해 1회 재시도
async function fetchLawListPageWithRetry(baseUrl, page) {
  try {
    return await fetchLawListPage(baseUrl, page);
  } catch (firstErr) {
    console.error(`목록 ${page}페이지 1차 실패, 재시도:`, firstErr.message);
    await new Promise(r => setTimeout(r, 700));
    return await fetchLawListPage(baseUrl, page);
  }
}

// ① 선택한 연/월 + 기준(시행일 or 공포일)에 해당하는 노동법 목록 가져오기
//    basis=eff(기본, 시행일 기준) / basis=prom(공포일 기준)
app.get('/api/laws', async (req, res) => {
  const { year, month } = req.query;
  const basis = req.query.basis === 'prom' ? 'prom' : 'eff';

  const mm = String(month).padStart(2, '0');
  const lastDay = String(new Date(year, month, 0).getDate()).padStart(2, '0');
  const startYmd = `${year}${mm}01`;
  const endYmd = `${year}${mm}${lastDay}`;
  const range = `${startYmd}~${endYmd}`;
  const dateParam = basis === 'prom' ? `ancYd=${range}` : `efYd=${range}`;

  const baseUrl = `https://www.law.go.kr/DRF/lawSearch.do?OC=${OC}&target=eflaw&type=JSON&display=100&${dateParam}`;
  const inRange = v => { const s = String(v || ''); return s >= startYmd && s <= endYmd; };

  try {
    // 한 페이지에 최대 100건이라, 전체 건수(totalCnt)만큼 모든 페이지를 가져옴
    const first = await fetchLawListPageWithRetry(baseUrl, 1);   // 1페이지 실패 = 조회 불가 → 아래 catch에서 오류 응답
    let allLaws = [...first.laws];
    const totalPages = Math.min(Math.ceil(first.total / 100), 10);
    let warning = null;

    for (let p = 2; p <= totalPages; p++) {
      try {
        const next = await fetchLawListPageWithRetry(baseUrl, p);
        allLaws = allLaws.concat(next.laws);
      } catch (pageErr) {
        // 2페이지 이후 실패: 가져온 데이터까지만 보여주되, 누락 가능성을 화면에 경고
        console.error(`목록 ${p}/${totalPages}페이지 실패:`, pageErr.message);
        warning = `법제처 목록 ${totalPages}페이지 중 ${p}페이지부터 가져오지 못해 일부 법령이 누락됐을 수 있습니다. 잠시 후 다시 검색해 주세요. (${pageErr.message})`;
        break;
      }
    }

    const laborLaws = allLaws.filter(law => {
      if (!law || !law.소관부처명 || !law.소관부처명.includes('고용노동부')) return false;
      if (String(law.법령명한글 || '').includes('직제')) return false;
      if (basis === 'prom') {
        // 공포일 기준: 선택한 달에 공포된 법령은 현행/시행예정/연혁 구분 없이 모두 표시
        return inRange(law.공포일자);
      }
      // 시행일 기준: 현행 + 시행예정만 (이후 개정으로 대체된 옛 버전은 제외)
      return inRange(law.시행일자) && (law.현행연혁코드 === '현행' || law.현행연혁코드 === '시행예정');
    });

    const laws = laborLaws.map(l => ({ ...l, 법령명한글: l.법령명한글 || '(법령명 없음)' }));
    res.json({ count: laws.length, basis, warning, laws });
  } catch (e) {
    console.error('진짜 에러 내용 (laws):', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/law-detail', async (req, res) => {
  const { mst, efYd } = req.query;
  const url = `https://www.law.go.kr/DRF/lawService.do?OC=${OC}&target=eflaw&MST=${mst}&type=JSON&efYd=${efYd}`;

  try {
    const response = await fetch(url, {
      headers: { 'Referer': 'https://www.law.go.kr/' }
    });
    const rawText = await response.text();
    try {
      const data = JSON.parse(rawText);
      res.json(data);
    } catch (parseErr) {
      res.status(500).json({ error: 'JSON이 아닌 응답을 받았습니다', preview: rawText.slice(0, 3000) });
    }
  } catch (e) {
    console.error('진짜 에러 내용 (law-detail):', e);
    res.status(500).json({ error: e.message });
  }
});

// ---- 헬퍼 함수들 ----

// law.go.kr 본문에 섞여 들어오는 <img ...>...ASCII표...</img> 블록을 걸러내기
function stripEmbeddedTables(text) {
  if (!text) return text;
  return text
    .replace(/<img[^>]*>[\s\S]*?<\/img>/g, '\n[※ 표 있음 - 원문은 law.go.kr에서 확인해주세요]\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// 조문을 "제목 / 항 / 호" 조각(segment) 배열로 쪼개기
function buildSegments(article) {
  const segs = [];
  if (article.조문내용) {
    segs.push({ 항번호: null, 호번호: null, text: stripEmbeddedTables(article.조문내용) });
  }
  let hangList = article.항;
  if (hangList) {
    if (!Array.isArray(hangList)) hangList = [hangList];
    hangList.forEach(hang => {
      if (hang.항내용) {
        segs.push({ 항번호: hang.항번호 || null, 호번호: null, text: stripEmbeddedTables(hang.항내용) });
      }
      let hoList = hang.호;
      if (hoList) {
        if (!Array.isArray(hoList)) hoList = [hoList];
        hoList.forEach(ho => {
          if (ho.호내용) {
            segs.push({
              항번호: hang.항번호 || null,
              호번호: (ho.호번호 || '').replace(/\.$/, ''),
              text: '  ' + stripEmbeddedTables(ho.호내용)
            });
          }
        });
      }
    });
  }
  return segs;
}

function joinSegs(segs) { return segs.map(s => s.text).join('\n'); }
function cloneSegs(segs) { return segs.map(s => ({ ...s })); }

// 개정문 문장 하나를 분석: 위치 + 전/후 문구 쌍 + 동작유형(change/new/delete)
function parseAmendmentLine(line) {
  if (!line) return null;

  const locMatch = line.match(/^(.*?)\s*중\s+(.*)$/);
  let location = locMatch ? locMatch[1].trim() : '';
  const body = locMatch ? locMatch[2] : line;

  const pairRegex = /"([^"]+)"\s*(?:을|를)\s*"([^"]+)"\s*(?:로|으로)/g;
  const pairs = [];
  let m;
  while ((m = pairRegex.exec(body)) !== null) {
    pairs.push({ before: m[1], after: m[2] });
  }

  let actionType = 'change';
  if (/다음과\s*같이\s*신설한다/.test(line) || /(?:^|\s)신설한다\.?\s*$/.test(line)) {
    actionType = 'new';
  } else if (/(?:^|\s)삭제한다\.?\s*$/.test(line)) {
    actionType = 'delete';
  }

  if (!location) {
    const locOnly = line.match(/^(제\d+조(?:의\d+)?(?:제\d+항)?(?:제\d+호)?)/);
    location = locOnly ? locOnly[1] : '';
  }

  if (pairs.length === 0 && actionType === 'change') return null;

  return { location, pairs, actionType, raw: line };
}

function extractArticleNo(location) {
  const m = location.match(/^제(\d+)조(?:의(\d+))?/);
  if (!m) return null;
  return { 조문번호: m[1], 조문가지번호: m[2] || null };
}

function parseLocationDetail(location) {
  const 조 = location.match(/^제(\d+)조(?:의(\d+))?/);
  if (!조) return null;
  const 항 = location.match(/제(\d+)항/);
  const 호 = location.match(/제(\d+)호/);
  return {
    조문번호: 조[1],
    조문가지번호: 조[2] || null,
    항번호: 항 ? 항[1] : null,
    호번호: 호 ? 호[1] : null,
    scopeLevel: 호 ? 'ho' : (항 ? 'hang' : 'article')
  };
}

const CIRCLED = ['', '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];
function circledOf(n) { return CIRCLED[Number(n)] || null; }

function segMatchesLocation(seg, loc) {
  if (loc.scopeLevel === 'hang') return seg.항번호 === circledOf(loc.항번호);
  if (loc.scopeLevel === 'ho') return seg.항번호 === circledOf(loc.항번호) && String(seg.호번호) === String(loc.호번호);
  return false;
}

// "20260819" -> "2026.8.19" (법령 원문의 <개정 2026.8.19> 표기와 형식 맞추기)
function formatDateNoLeadingZero(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length !== 8) return null;
  const y = yyyymmdd.slice(0, 4);
  const m = String(Number(yyyymmdd.slice(4, 6)));
  const d = String(Number(yyyymmdd.slice(6, 8)));
  return `${y}.${m}.${d}`;
}

// 조각(호) 안에 "1. 삭제<2018.12.31>" 처럼 항목 단위 삭제 스텁이 있으면 파란색 표시 대상으로 마킹
function markSubDeletionStubs(segsArray, dateMarkers) {
  let marked = false;
  const result = segsArray.map(s => {
    const t = s.text.trim();
    const m = t.match(/^[^\s"']+\.\s*삭제\s*[<〈]([^>〉]*)[>〉]\s*$/);
    if (m && !s.text.includes('【')) {
      const stubDate = m[1].trim();
      // 이번 조회 기준 날짜(시행일/공포일)와 일치하는 삭제만 "지금 바뀐 것"으로 표시
      // (몇 년 전에 이미 삭제된 옛날 항목까지 잘못 강조되지 않도록)
      if (dateMarkers.includes(stubDate)) {
        marked = true;
        return { ...s, text: `【${s.text}】` };
      }
    }
    return s;
  });
  return { segs: result, marked };
}

// ③ 조문 전체 개정 전/후 비교표 생성
app.get('/api/law-summary', async (req, res) => {
  const { mst, efYd } = req.query;
  const url = `https://www.law.go.kr/DRF/lawService.do?OC=${OC}&target=eflaw&MST=${mst}&type=JSON&efYd=${efYd}`;

  try {
    const response = await fetch(url, {
      headers: { 'Referer': 'https://www.law.go.kr/' }
    });
    const data = await response.json();
    const law = data.법령;
    if (!law) return res.status(500).json({ error: '법령 데이터 형식이 예상과 다릅니다' });

    const 법령명 = law.기본정보?.법령명_한글 || '';
    const 시행일자 = law.기본정보?.시행일자 || '';
    const 공포일자 = law.기본정보?.공포일자 || '';
    const isNewLaw = (law.기본정보?.제개정구분?.content || law.기본정보?.제개정구분 || '').includes('제정');

    const 개정이유원본 = law.제개정이유?.제개정이유내용 || [];
    const 시사점 = 개정이유원본
      .flat()
      .filter(line => line && !line.includes('◇') && !line.includes('[법제처') && !line.includes('[일부개정]') && !line.includes('[전부개정]'))
      .join(' ')
      .trim();

    const 개정문원본 = (law.개정문?.개정문내용 || []).flat();
    const parsedLines = 개정문원본.map(parseAmendmentLine).filter(Boolean);

    const dateMarkers = [formatDateNoLeadingZero(시행일자), formatDateNoLeadingZero(공포일자)].filter(Boolean);

    const 조문목록 = law.조문?.조문단위 || [];

    // 신규 제정 법률: 개정 전/후 비교가 아니라 "조문 전체가 신규"로 처리
    if (isNewLaw) {
      const 비교표 = 조문목록
        .filter(j => j.조문여부 === '조문')
        .map(article => {
          const segs = buildSegments(article);
          const afterBase = joinSegs(segs);
          const 위치제목 = `제${article.조문번호}조${article.조문가지번호 ? '의' + article.조문가지번호 : ''}` +
            (article.조문제목 ? `(${article.조문제목})` : '');
          return { 구분: '제정', 위치: 위치제목, 개정전: '(신규 제정된 법률로 개정 전 조문이 없습니다)', 개정후: afterBase };
        });
      return res.json({ 법령명, 시행일자, 공포일자, 시사점: 시사점 || '개정이유 정보가 제공되지 않았습니다.', 비교표 });
    }

    const 변경조문 = 조문목록.filter(j => j.조문변경여부 === 'Y');

    const 비교표 = 변경조문.map(article => {
      const segs = buildSegments(article);
      const afterBase = joinSegs(segs);
      const 위치제목 = `제${article.조문번호}조${article.조문가지번호 ? '의' + article.조문가지번호 : ''}` +
        (article.조문제목 ? `(${article.조문제목})` : '');

      const matched = parsedLines.filter(p => {
        const no = extractArticleNo(p.location);
        return no && no.조문번호 === article.조문번호 && ((no.조문가지번호 || null) === (article.조문가지번호 || null));
      });

      const trimmedAfter = afterBase.trim();
      const isDeletionStub = trimmedAfter.length < 60 &&
        /삭제\s*([<〈][^>〉]*[>〉])?\s*$/.test(trimmedAfter);

      let 구분 = '개정';
      let afterMarked, beforeMarked;

      if (isDeletionStub) {
        // 조문 전체가 삭제 스텁인 경우
        구분 = '삭제';
        afterMarked = `【${trimmedAfter}】`;
        beforeMarked = '(삭제 전 원문은 제공되지 않습니다 - 법령 연혁 조회에서 확인 가능합니다)';
      } else {
        let afterSegs = cloneSegs(segs);
        let beforeSegs = cloneSegs(segs);
        let anyMark = false;
        let hasNew = false, hasDelete = false;

        // 1) 인용부호 기반 문구 치환 / 신설·삭제 위치 처리
        matched.forEach(p => {
          const loc = parseLocationDetail(p.location);
          if (!loc) return;

          if (p.actionType === 'new') {
            hasNew = true;
            if (loc.scopeLevel === 'article') {
              afterSegs = segs.map(s => ({ ...s, text: `【${s.text}】` }));
              beforeSegs = [];
            } else {
              afterSegs = afterSegs.map(s => segMatchesLocation(s, loc) ? { ...s, text: `【${s.text}】` } : s);
              beforeSegs = beforeSegs.filter(s => !segMatchesLocation(s, loc));
            }
            anyMark = true;
          } else if (p.actionType === 'delete') {
            hasDelete = true;
            if (loc.scopeLevel !== 'article') {
              beforeSegs = beforeSegs.map(s => segMatchesLocation(s, loc) ? { ...s, text: `【${s.text}】` } : s);
              afterSegs = afterSegs.filter(s => !segMatchesLocation(s, loc));
              anyMark = true;
            }
          } else {
            p.pairs.forEach(pair => {
              let found = false;
              afterSegs = afterSegs.map(s => {
                if (s.text.includes(pair.after)) {
                  found = true;
                  return { ...s, text: s.text.split(pair.after).join(`【${pair.after}】`) };
                }
                return s;
              });
              if (found) anyMark = true;
              beforeSegs = beforeSegs.map(s => {
                if (s.text.includes(pair.after)) {
                  return { ...s, text: s.text.split(pair.after).join(`【${pair.before}】`) };
                }
                return s;
              });
            });
          }
        });

        if (matched.length === 0 && (article.조문참고자료 || '').includes('신설')) {
          hasNew = true;
          afterSegs = segs.map(s => ({ ...s, text: `【${s.text}】` }));
          beforeSegs = [];
          anyMark = true;
        }

        // 2) 항목(호) 단위 삭제 스텁("1. 삭제<날짜>") 마킹 - 항상 수행
        const afterSub = markSubDeletionStubs(afterSegs, dateMarkers);
        const beforeSub = markSubDeletionStubs(beforeSegs, dateMarkers);
        afterSegs = afterSub.segs;
        beforeSegs = beforeSub.segs;
        if (afterSub.marked || beforeSub.marked) anyMark = true;

        // 3) 표(이미지) 변경 - 문구로 못 찾았을 때 표 안내문이라도 강조
        if (!anyMark) {
          const markTable = s => s.text.includes('[※ 표 있음')
            ? { ...s, text: s.text.replace('[※ 표 있음 - 원문은 law.go.kr에서 확인해주세요]', '【[※ 표 내용이 변경되었습니다 - 원문은 law.go.kr에서 확인해주세요]】') }
            : s;
          const beforeAfterTable = afterSegs.map(markTable);
          const beforeBeforeTable = beforeSegs.map(markTable);
          if (JSON.stringify(beforeAfterTable) !== JSON.stringify(afterSegs)) anyMark = true;
          afterSegs = beforeAfterTable;
          beforeSegs = beforeBeforeTable;
        }

        if (hasNew) 구분 = '신설';
        else if (hasDelete) 구분 = '삭제';

        afterMarked = joinSegs(afterSegs) || afterBase;
        beforeMarked = beforeSegs.length ? joinSegs(beforeSegs) : '(해당 조문이 이번 개정으로 신설되었습니다)';
      }

      // 개정 전/후가 (표시 마커를 제외하고) 완전히 동일한 문구라면
      // 실질적으로 비교할 내용이 없는 것이므로 표에서 제외
      const stripMarkers = t => (t || '').replace(/[【】《》]/g, '').trim();
      if (stripMarkers(beforeMarked) === stripMarkers(afterMarked)) {
        return null;
      }

      return { 구분, 위치: 위치제목, 개정전: beforeMarked, 개정후: afterMarked };
    }).filter(Boolean);

    res.json({ 법령명, 시행일자, 공포일자, 시사점: 시사점 || '개정이유 정보가 제공되지 않았습니다.', 비교표 });
  } catch (e) {
    console.error('진짜 에러 내용 (law-summary):', e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`서버 켜짐: http://localhost:${PORT}`);
});