import { describe, it, expect } from 'vitest';
import { parseFedFomc, parseBoeMpc, parseBojMpm, parseEcbMpc } from '../providers/centralBankCalendar';
import { parseForexFactoryJson } from '../providers/calendarProvider';

describe('central bank calendar parsers', () => {
  it('parses Fed FOMC panels into USD HIGH events at 18:00 UTC on the last day', () => {
    const html = `
      <div class="panel panel-default">
        <div class="panel-heading">2026 FOMC Meetings</div>
        <div class="row fomc-meeting">January 27-28 Statement: PDF | HTML Press Conference</div>
        <div class="row fomc-meeting">March 17-18 Statement: PDF | HTML Press Conference</div>
      </div>
    `;
    const events = parseFedFomc(html);
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('FOMC Rate Decision');
    expect(events[0].currency).toBe('USD');
    expect(events[0].impact).toBe('HIGH');
    // Jan = EST: 2pm ET is 19:00 UTC (DST-aware; was hardcoded 18:00 year-round)
    expect(events[0].timestamp).toBe(Date.UTC(2026, 0, 28, 19, 0, 0));
    // Mar 18 is after the US DST switch → EDT → 18:00 UTC
    expect(events[1].timestamp).toBe(Date.UTC(2026, 2, 18, 18, 0, 0));
  });

  it('parses BoE MPC tables per year into GBP HIGH events at 12:00 UTC', () => {
    const html = `
      <h2>2026 confirmed dates</h2>
      <table><tr><td>Thursday 5 February</td><td>February MPC Summary and minutes</td></tr></table>
      <h2>2027 provisional dates</h2>
      <table><tr><td>Thursday 4 February</td><td>February MPC Summary and minutes</td></tr></table>
    `;
    const events = parseBoeMpc(html);
    expect(events).toHaveLength(2);
    expect(events[0].currency).toBe('GBP');
    expect(events[0].timestamp).toBe(Date.UTC(2026, 1, 5, 12, 0, 0));
    expect(events[1].timestamp).toBe(Date.UTC(2027, 1, 4, 12, 0, 0));
  });

  it('parses BoJ MPM meeting rows into JPY HIGH events at 03:00 UTC on the last day', () => {
    const html = `
      <h2>2026</h2>
      <table>
        <tr><td>Mar. 17 (Wed.), 18 (Thurs.)</td><td>Some other column</td></tr>
        <tr><td>June 15 (Mon.), 16 (Tues.)</td><td>Another column</td></tr>
      </table>
    `;
    const events = parseBojMpm(html);
    expect(events).toHaveLength(2);
    expect(events[0].currency).toBe('JPY');
    expect(events[0].timestamp).toBe(Date.UTC(2026, 2, 18, 3, 0, 0));
    expect(events[1].timestamp).toBe(Date.UTC(2026, 5, 16, 3, 0, 0));
  });

  it('parses ECB calendar rows into EUR HIGH events', () => {
    const html = `
      <table class="calendar">
        <tbody><tr><td>12 March 2026</td><td>Monetary policy meeting</td></tr></tbody>
      </table>
    `;
    const events = parseEcbMpc(html);
    expect(events).toHaveLength(1);
    expect(events[0].currency).toBe('EUR');
    expect(events[0].timestamp).toBe(Date.UTC(2026, 2, 12, 13, 15, 0));
  });

  it('parses ForexFactory JSON events', () => {
    const json = [
      { title: 'FOMC Rate Decision', country: 'USD', date: '2026-08-14T18:00:00', impact: 'High', forecast: '5.50%', previous: '5.25%' },
      { title: 'CPI YoY', country: 'EUR', date: '2026-08-15T09:00:00', impact: 'Medium', forecast: '', previous: '2.0%' },
    ];
    const events = parseForexFactoryJson(json as never);
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('FOMC Rate Decision');
    expect(events[0].impact).toBe('HIGH');
    expect(events[0].previous).toBeCloseTo(5.25, 2);
    expect(events[1].currency).toBe('EUR');
  });

  it('returns no events for malformed HTML (fail-safe)', () => {
    expect(parseFedFomc('<html><div>nothing here</div></html>')).toHaveLength(0);
    expect(parseBoeMpc('')).toHaveLength(0);
    expect(parseBojMpm('<h2>Not a year</h2><table></table>')).toHaveLength(0);
  });
});
