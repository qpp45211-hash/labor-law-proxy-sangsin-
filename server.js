require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static(__dirname));

const OC = process.env.LAW_OC;

app.get('/api/laws', async (req, res) => {
  const { year, month } = req.query;
  const mm = String(month).padStart(2, '0');
  const lastDay = new Date(year, month, 0).getDate();
  const efYd = `${year}${mm}01~${year}${mm}${lastDay}`;

  const url = `https://www.law.go.kr/DRF/lawSearch.do?OC=${OC}&target=eflaw&type=JSON&display=100&efYd=${efYd}`;

  try {
    const response = await fetch(url, {
      headers: { 'Referer': 'https://www.law.go.kr/' }
    });
    const data = await response.json();

    const allLaws = data.LawSearch?.law || [];

    const laborLaws = allLaws.filter(law =>
      law.소관부처명 &&
      law.소관부처명.includes('고용노동부') &&
      (law.현행연혁코드 === '현행' || law.현행연혁코드 === '시행예정') &&
      !law.법령명한글.includes('직제')
    );

    res.json({ count: laborLaws.length, laws: laborLaws });
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

function stripEmbeddedTables(text) {
  if (!text) return text;
  return text
    .replace(/<img[^>]*>[\s\S]*?<\/img>/g, '\n[※ 표 있음 - 원문은 law.go.kr에서 확인해주세요]\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

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

function formatDateNoLeadingZero(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length !== 8) return null;
  const y = yyyymmdd.slice(0, 4);
  const m = String(Number(yyyymmdd.slice(4, 6)));
  const d = String(Number(yyyymmdd.slice(6, 8)));
  return `${y}.${m}.${d}`;
}

function textHasDateMarker(text, dateMarkers) {
  const brackets = text.match(/<[^>]*>/g) || [];
  return brackets.some(b => dateMarkers.some(d => b.includes(d)));
}

function markSubDeletionStubs(segsArray) {
  let marked = false;
  const result = segsArray.map(s => {
    const t = s.text.trim();
    if (/^[^\s"']+\.\s*삭제\s*[<〈][^>〉]*[>〉]\s*$/.test(t) && !s.text.includes('【')) {
      marked = true;
      return { ...s, text: `【${s.text}】` };
    }
    return s;
  });
  return { segs: result, marked };
}

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
        구분 = '삭제';
        afterMarked = `【${trimmedAfter}】`;
        beforeMarked = '(삭제 전 원문은 제공되지 않습니다 - 법령 연혁 조회에서 확인 가능합니다)';
      } else {
        let afterSegs = cloneSegs(segs);
        let beforeSegs = cloneSegs(segs);
        let anyMark = false;
        let hasNew = false, hasDelete = false;

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

        const afterSub = markSubDeletionStubs(afterSegs);
        const beforeSub = markSubDeletionStubs(beforeSegs);
        afterSegs = afterSub.segs;
        beforeSegs = beforeSub.segs;
        if (afterSub.marked || beforeSub.marked) anyMark = true;

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

        if (!anyMark && textHasDateMarker(afterBase, dateMarkers)) {
          afterSegs = segs.map(s => ({ ...s, text: `【${s.text}】` }));
          beforeSegs = segs.map(s => ({ ...s, text: `【${s.text}】` }));
          anyMark = true;
        }

        if (hasNew) 구분 = '신설';
        else if (hasDelete) 구분 = '삭제';

        afterMarked = joinSegs(afterSegs) || afterBase;
        beforeMarked = beforeSegs.length ? joinSegs(beforeSegs) : '(해당 조문이 이번 개정으로 신설되었습니다)';

        if (!anyMark) {
          afterMarked += '\n《※ 세부 변경 문구를 자동으로 특정하지 못했습니다 - 원문을 확인해 주세요》';
        }
      }

      return { 구분, 위치: 위치제목, 개정전: beforeMarked, 개정후: afterMarked };
    });

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