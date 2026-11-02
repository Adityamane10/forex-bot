/**
 * Multi-Timeframe Analysis Engine
 * Provides hierarchical context across 1h/30m/15m/5m/3m/1m
 */
import { logger } from '../core/logger';
import type { IndiaTimeframe, IndiaCandle } from '@fx/shared';
import type { IndiaCandleEngine } from './candle-engine';
import type { IndiaIndicatorEngine } from './indicator-engine';

export interface MultiTimeframeContext {
  token: string;
  timestamp: number;
  
  // Hierarchical timeframes
  timeframes: {
    h1: TimeframeAnalysis;
    m30: TimeframeAnalysis;
    m15: TimeframeAnalysis;
    m5: TimeframeAnalysis;
    m3?: TimeframeAnalysis;
    m1?: TimeframeAnalysis;
  };
  
  // Cross-timeframe signals
  alignment: {
    trend: 'ALIGNED_BULLISH' | 'ALIGNED_BEARISH' | 'MIXED' | 'NO_TREND';
    strength: number; // 0-1 (how many TFs agree)
    description: string;
  };
  
  // Higher TF levels projected to lower TF
  keyLevels: {
    support: number[];
    resistance: number[];
    source: string; // e.g., "1h swing low", "30m resistance"
  }[];
  
  // Multi-TF divergences
  divergences: Divergence[];
  
  // Entry quality score
  entryQuality: {
    score: number; // 0-100
    factors: string[];
  };
}

export interface TimeframeAnalysis {
  timeframe: IndiaTimeframe;
  
  // Trend
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  trendStrength: number; // 0-1
  
  // Structure
  structure: 'UPTREND' | 'DOWNTREND' | 'RANGING' | 'CHOPPY';
  marketPhase: 'MARKUP' | 'MARKDOWN' | 'ACCUMULATION' | 'DISTRIBUTION';
  
  // Key levels
  support: number;
  resistance: number;
  swingHigh: number | null;
  swingLow: number | null;
  
  // Momentum
  momentum: 'STRONG_UP' | 'WEAK_UP' | 'NEUTRAL' | 'WEAK_DOWN' | 'STRONG_DOWN';
  rsi: number;
  macdSignal: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  
  // Volume
  volumeState: 'HIGH' | 'AVERAGE' | 'LOW';
  volumeTrend: 'INCREASING' | 'DECREASING' | 'STABLE';
  
  // Price action
  lastClose: number;
  changePercent: number;
  barsInTrend: number;
}

export interface Divergence {
  type: 'BULLISH' | 'BEARISH';
  timeframes: [IndiaTimeframe, IndiaTimeframe];
  description: string;
  strength: 'WEAK' | 'MODERATE' | 'STRONG';
}

export class MultiTimeframeEngine {
  // TF hierarchy: higher to lower
  private readonly TF_HIERARCHY: IndiaTimeframe[] = ['1h', '30m', '15m', '5m', '3m', '1m'];
  
  constructor(
    private candles: IndiaCandleEngine,
    private indicators: IndiaIndicatorEngine
  ) {}
  
  /**
   * Analyze token across all timeframes
   */
  async analyze(token: string): Promise<MultiTimeframeContext> {
    const timestamp = Date.now();
    
    // Analyze each timeframe
    const timeframes: any = {};
    for (const tf of this.TF_HIERARCHY) {
      const analysis = await this.analyzeTimeframe(token, tf);
      if (analysis) {
        timeframes[tf === '1h' ? 'h1' : `m${tf.replace(/[mh]/g, '')}`] = analysis;
      }
    }
    
    // Calculate trend alignment
    const alignment = this.calculateAlignment(Object.values(timeframes));
    
    // Extract key levels from higher timeframes
    const keyLevels = this.extractKeyLevels(timeframes);
    
    // Detect divergences
    const divergences = this.detectDivergences(timeframes);
    
    // Calculate entry quality
    const entryQuality = this.calculateEntryQuality(timeframes, alignment, keyLevels);
    
    return {
      token,
      timestamp,
      timeframes,
      alignment,
      keyLevels,
      divergences,
      entryQuality,
    };
  }
  
  /**
   * Analyze single timeframe
   */
  private async analyzeTimeframe(token: string, tf: IndiaTimeframe): Promise<TimeframeAnalysis | null> {
    try {
      const candles = this.candles.getCandles(token, tf, 100);
      if (candles.length < 20) return null;
      
      const snapshot = await this.indicators.getSnapshot(token, candles, tf, false);
      if (!snapshot) return null;
      
      const last = candles[candles.length - 1];
      const prev = candles[candles.length - 2];
      
      // Trend determination
      const ema20 = snapshot.values.ema20;
      const ema50 = snapshot.values.ema50;
      let trend: TimeframeAnalysis['trend'] = 'NEUTRAL';
      let trendStrength = 0;
      
      if (ema20 !== null && ema50 !== null && last.close > ema20 && ema20 > ema50) {
        trend = 'BULLISH';
        trendStrength = Math.min(1, (last.close - ema50) / ema50 / 0.02); // 2% = max strength
      } else if (ema20 !== null && ema50 !== null && last.close < ema20 && ema20 < ema50) {
        trend = 'BEARISH';
        trendStrength = Math.min(1, (ema50 - last.close) / ema50 / 0.02);
      }
      
      // Structure
      const structure = this.determineStructure(candles);
      const marketPhase = this.determineMarketPhase(candles, snapshot);
      
      // Momentum
      const momentum = this.analyzeMomentum(snapshot);
      const macd = snapshot.values.macd;
      const macdSignal = snapshot.values.macdSignal;
      const macdState: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 
        (macd !== null && macdSignal !== null && macd > macdSignal) ? 'BULLISH' : 
        (macd !== null && macdSignal !== null && macd < macdSignal) ? 'BEARISH' : 'NEUTRAL';
      
      // Volume
      const volumeState = this.analyzeVolume(candles);
      const volumeTrend = this.analyzeVolumeTrend(candles);
      
      // Count bars in current trend
      let barsInTrend = 1;
      const trendDirection = last.close > prev.close;
      for (let i = candles.length - 2; i >= 0; i--) {
        const curr = candles[i];
        const prv = candles[i - 1];
        if (!prv) break;
        if ((curr.close > prv.close) === trendDirection) {
          barsInTrend++;
        } else {
          break;
        }
      }
      
      return {
        timeframe: tf,
        trend,
        trendStrength,
        structure,
        marketPhase,
        support: snapshot.values.support ?? last.low,
        resistance: snapshot.values.resistance ?? last.high,
        swingHigh: snapshot.values.swingHigh ?? null,
        swingLow: snapshot.values.swingLow ?? null,
        momentum,
        rsi: snapshot.values.rsi ?? 50,
        macdSignal: macdState,
        volumeState,
        volumeTrend,
        lastClose: last.close,
        changePercent: ((last.close - prev.close) / prev.close) * 100,
        barsInTrend,
      };
    } catch (err) {
      logger.warn('multi-tf: timeframe analysis failed', { token, tf, err: String(err) });
      return null;
    }
  }
  
  /**
   * Determine market structure
   */
  private determineStructure(candles: IndiaCandle[]): TimeframeAnalysis['structure'] {
    if (candles.length < 10) return 'CHOPPY';
    
    const recent = candles.slice(-10);
    let higherHighs = 0;
    let lowerLows = 0;
    let higherLows = 0;
    let lowerHighs = 0;
    
    for (let i = 1; i < recent.length; i++) {
      if (recent[i].high > recent[i - 1].high) higherHighs++;
      if (recent[i].low < recent[i - 1].low) lowerLows++;
      if (recent[i].low > recent[i - 1].low) higherLows++;
      if (recent[i].high < recent[i - 1].high) lowerHighs++;
    }
    
    if (higherHighs > 6 && higherLows > 6) return 'UPTREND';
    if (lowerLows > 6 && lowerHighs > 6) return 'DOWNTREND';
    if (Math.abs(recent[recent.length - 1].close - recent[0].close) / recent[0].close < 0.005) {
      return 'RANGING';
    }
    
    return 'CHOPPY';
  }
  
  /**
   * Determine market phase
   */
  private determineMarketPhase(candles: IndiaCandle[], snapshot: any): TimeframeAnalysis['marketPhase'] {
    const last = candles[candles.length - 1];
    const volumeAvg = candles.slice(-20).reduce((sum, c) => sum + c.volume, 0) / 20;
    const highVolume = last.volume > volumeAvg * 1.5;
    
    const ema20 = snapshot.values.ema20;
    const ema50 = snapshot.values.ema50;
    
    // Markup: Strong uptrend with volume
    if (ema20 !== null && ema50 !== null && last.close > ema20 && ema20 > ema50 && highVolume) {
      return 'MARKUP';
    }
    
    // Markdown: Strong downtrend with volume
    if (ema20 !== null && ema50 !== null && last.close < ema20 && ema20 < ema50 && highVolume) {
      return 'MARKDOWN';
    }
    
    // Accumulation: Ranging near lows
    if (ema20 !== null && ema50 !== null && Math.abs(last.close - ema20) / ema20 < 0.01 && last.close < ema50) {
      return 'ACCUMULATION';
    }
    
    // Distribution: Ranging near highs
    if (ema20 !== null && ema50 !== null && Math.abs(last.close - ema20) / ema20 < 0.01 && last.close > ema50) {
      return 'DISTRIBUTION';
    }
    
    return 'ACCUMULATION';
  }
  
  /**
   * Analyze momentum
   */
  private analyzeMomentum(snapshot: any): TimeframeAnalysis['momentum'] {
    const rsi = snapshot.values.rsi;
    const adx = snapshot.values.adx;
    
    if (rsi !== null && adx !== null && rsi > 70 && adx > 25) return 'STRONG_UP';
    if (rsi !== null && adx !== null && rsi > 50 && adx > 20) return 'WEAK_UP';
    if (rsi !== null && adx !== null && rsi < 30 && adx > 25) return 'STRONG_DOWN';
    if (rsi !== null && adx !== null && rsi < 50 && adx > 20) return 'WEAK_DOWN';
    
    return 'NEUTRAL';
  }
  
  /**
   * Analyze volume state
   */
  private analyzeVolume(candles: IndiaCandle[]): TimeframeAnalysis['volumeState'] {
    if (candles.length < 20) return 'AVERAGE';
    
    const last = candles[candles.length - 1];
    const avg = candles.slice(-20).reduce((sum, c) => sum + c.volume, 0) / 20;
    
    if (last.volume > avg * 1.5) return 'HIGH';
    if (last.volume < avg * 0.5) return 'LOW';
    return 'AVERAGE';
  }
  
  /**
   * Analyze volume trend
   */
  private analyzeVolumeTrend(candles: IndiaCandle[]): TimeframeAnalysis['volumeTrend'] {
    if (candles.length < 10) return 'STABLE';
    
    const recent = candles.slice(-5).reduce((sum, c) => sum + c.volume, 0) / 5;
    const older = candles.slice(-10, -5).reduce((sum, c) => sum + c.volume, 0) / 5;
    
    if (recent > older * 1.2) return 'INCREASING';
    if (recent < older * 0.8) return 'DECREASING';
    return 'STABLE';
  }
  
  /**
   * Calculate trend alignment across timeframes
   */
  private calculateAlignment(timeframes: TimeframeAnalysis[]): MultiTimeframeContext['alignment'] {
    if (timeframes.length === 0) {
      return { trend: 'NO_TREND', strength: 0, description: 'Insufficient data' };
    }
    
    const bullish = timeframes.filter(t => t.trend === 'BULLISH').length;
    const bearish = timeframes.filter(t => t.trend === 'BEARISH').length;
    const total = timeframes.length;
    
    const strength = Math.max(bullish, bearish) / total;
    
    if (bullish >= total * 0.75) {
      return {
        trend: 'ALIGNED_BULLISH',
        strength,
        description: `${bullish}/${total} timeframes bullish`,
      };
    }
    
    if (bearish >= total * 0.75) {
      return {
        trend: 'ALIGNED_BEARISH',
        strength,
        description: `${bearish}/${total} timeframes bearish`,
      };
    }
    
    if (Math.abs(bullish - bearish) <= 1) {
      return {
        trend: 'NO_TREND',
        strength: 0,
        description: 'No clear trend across timeframes',
      };
    }
    
    return {
      trend: 'MIXED',
      strength: 0.5,
      description: `Mixed: ${bullish} bullish, ${bearish} bearish`,
    };
  }
  
  /**
   * Extract key support/resistance from higher timeframes
   */
  private extractKeyLevels(timeframes: Record<string, TimeframeAnalysis>): MultiTimeframeContext['keyLevels'] {
    const levels: MultiTimeframeContext['keyLevels'] = [];
    
    // 1h levels (most important)
    if (timeframes.h1) {
      if (timeframes.h1.swingHigh) {
        levels.push({
          support: [],
          resistance: [timeframes.h1.swingHigh],
          source: '1h swing high',
        });
      }
      if (timeframes.h1.swingLow) {
        levels.push({
          support: [timeframes.h1.swingLow],
          resistance: [],
          source: '1h swing low',
        });
      }
      levels.push({
        support: [timeframes.h1.support],
        resistance: [timeframes.h1.resistance],
        source: '1h S/R',
      });
    }
    
    // 30m levels
    if (timeframes.m30) {
      levels.push({
        support: [timeframes.m30.support],
        resistance: [timeframes.m30.resistance],
        source: '30m S/R',
      });
    }
    
    // 15m levels
    if (timeframes.m15) {
      levels.push({
        support: [timeframes.m15.support],
        resistance: [timeframes.m15.resistance],
        source: '15m S/R',
      });
    }
    
    return levels;
  }
  
  /**
   * Detect divergences between timeframes
   */
  private detectDivergences(timeframes: Record<string, TimeframeAnalysis>): Divergence[] {
    const divergences: Divergence[] = [];
    
    // Check higher TF bearish but lower TF bullish (bullish divergence)
    if (timeframes.h1?.trend === 'BEARISH' && timeframes.m15?.trend === 'BULLISH') {
      divergences.push({
        type: 'BULLISH',
        timeframes: ['1h', '15m'],
        description: '1h bearish but 15m showing bullish momentum',
        strength: 'MODERATE',
      });
    }
    
    // Check higher TF bullish but lower TF bearish (bearish divergence)
    if (timeframes.h1?.trend === 'BULLISH' && timeframes.m15?.trend === 'BEARISH') {
      divergences.push({
        type: 'BEARISH',
        timeframes: ['1h', '15m'],
        description: '1h bullish but 15m showing bearish momentum',
        strength: 'MODERATE',
      });
    }
    
    return divergences;
  }
  
  /**
   * Calculate entry quality score
   */
  private calculateEntryQuality(
    timeframes: Record<string, TimeframeAnalysis>,
    alignment: MultiTimeframeContext['alignment'],
    keyLevels: MultiTimeframeContext['keyLevels']
  ): MultiTimeframeContext['entryQuality'] {
    let score = 0;
    const factors: string[] = [];
    
    // Trend alignment (0-40 points)
    if (alignment.trend === 'ALIGNED_BULLISH' || alignment.trend === 'ALIGNED_BEARISH') {
      score += 40 * alignment.strength;
      factors.push(`Trend aligned across ${(alignment.strength * 100).toFixed(0)}% of timeframes`);
    } else {
      factors.push('Trend not aligned (risky)');
    }
    
    // Higher TF structure (0-20 points)
    if (timeframes.h1) {
      if (timeframes.h1.structure === 'UPTREND' || timeframes.h1.structure === 'DOWNTREND') {
        score += 20;
        factors.push(`1h clear ${timeframes.h1.structure.toLowerCase()}`);
      }
    }
    
    // Momentum (0-20 points)
    if (timeframes.m15) {
      if (timeframes.m15.momentum === 'STRONG_UP' || timeframes.m15.momentum === 'STRONG_DOWN') {
        score += 20;
        factors.push(`15m strong momentum`);
      } else if (timeframes.m15.momentum !== 'NEUTRAL') {
        score += 10;
        factors.push(`15m weak momentum`);
      }
    }
    
    // Volume confirmation (0-10 points)
    if (timeframes.m5) {
      if (timeframes.m5.volumeState === 'HIGH') {
        score += 10;
        factors.push('High volume on 5m');
      }
    }
    
    // Near key level (0-10 points)
    if (timeframes.m5 && keyLevels.length > 0) {
      const currentPrice = timeframes.m5.lastClose;
      const nearLevel = keyLevels.some(level => {
        const supports = level.support;
        const resistances = level.resistance;
        return [...supports, ...resistances].some(lvl =>
          Math.abs(currentPrice - lvl) / lvl < 0.005 // Within 0.5%
        );
      });
      
      if (nearLevel) {
        score += 10;
        factors.push('Near key level');
      }
    }
    
    return {
      score: Math.min(100, Math.round(score)),
      factors,
    };
  }
}
