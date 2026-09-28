// 내보내기 엑셀 파일 (요약 · 날짜별 내역 · 수정 이력)
import writeExcelFile from 'write-excel-file/universal';
import { exportSheets } from './logic.js';

const head = (labels) => labels.map((value) => ({ value, fontWeight: 'bold', backgroundColor: '#E8EEF0' }));

export async function downloadExport(S, from, to, fileName) {
  const { summary, rows, revisions } = exportSheets(S, from, to);
  const sheets = [
    {
      sheet: '요약',
      data: [head(['번호', '기간 시작 자봉', '기간 중 변동', '기간 끝 자봉', '지금 자봉']), ...summary.map((r) => [r.no, r.start, r.change, r.end, r.now])],
      columns: [{ width: 8 }, { width: 14 }, { width: 12 }, { width: 12 }, { width: 10 }],
    },
    {
      sheet: '날짜별 내역',
      data: [
        head(['날짜', '번호', '항목', '세부', '점수', '비고']),
        ...rows.map((r) => [r.date, r.no, r.item, r.detail, r.points, r.note].map((value) => ({ value, color: r.voided ? '#999999' : undefined }))),
      ],
      columns: [{ width: 12 }, { width: 6 }, { width: 20 }, { width: 18 }, { width: 6 }, { width: 28 }],
    },
    {
      sheet: '수정 이력',
      data: [head(['수정 시각', '날짜', '번호', '바뀐 내용', '사유']), ...revisions.map((r) => [r.at, r.date, r.no, r.change, r.reason])],
      columns: [{ width: 17 }, { width: 12 }, { width: 6 }, { width: 36 }, { width: 24 }],
    },
  ];
  const blob = await writeExcelFile(sheets).toBlob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
