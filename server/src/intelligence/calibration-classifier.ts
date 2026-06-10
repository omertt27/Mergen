/**
 * calibration-classifier.ts — Online logistic regression over the calibration corpus.
 *
 * Replaces (and supplements) the static _demoteThreshold heuristic with a
 * proper learned model. After each verdict the weights update via SGD so the
 * classifier improves as production data accumulates.
 *
 * Features (4 + bias):
 *   x[0] = hypothesis confidence score       (0–1)
 *   x[1] = detector tag's empirical accuracy (0–1, 0.5 when untrusted)
 *   x[2] = log(tag sample count + 1) / log(500)  (normalised)
 *   x[3] = 1 if tag is trusted (>= MIN_SAMPLES), else 0
 *
 * Label: 1 = correct | partial,  0 = wrong
 *
 * The model is seeded with a weak prior (all weights = 0) and refines itself
 * purely from the local calibration corpus — no external data.
 */

const LEARNING_RATE = 0.05;
const L2_LAMBDA     = 0.001;   // weight decay — keeps weights small
const BIAS_IDX      = 4;       // 5 params total: w[0..3] + bias

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

export class CalibrationClassifier {
  /** [w0, w1, w2, w3, bias] */
  private w = [0.0, 0.0, 0.0, 0.0, 0.0];
  private _trainedOn = 0;

  get trainedOn(): number { return this._trainedOn; }

  /**
   * Train (or incrementally update) the classifier on a single labelled sample.
   * @param confidence   Hypothesis confidence score (0–1)
   * @param tagAccuracy  Empirical accuracy of the detector tag (0–1)
   * @param sampleCount  Number of verdicts for this tag
   * @param trusted      Whether the tag has enough samples to be trusted
   * @param isCorrect    Ground truth: true = correct/partial, false = wrong
   */
  update(
    confidence: number,
    tagAccuracy: number,
    sampleCount: number,
    trusted: boolean,
    isCorrect: boolean,
  ): void {
    const x = this._features(confidence, tagAccuracy, sampleCount, trusted);
    const y = isCorrect ? 1 : 0;
    const p = this._predict(x);
    const err = y - p;

    for (let i = 0; i < 4; i++) {
      // SGD update with L2 regularisation (skip bias from L2)
      this.w[i] = this.w[i] * (1 - LEARNING_RATE * L2_LAMBDA) + LEARNING_RATE * err * x[i];
    }
    this.w[BIAS_IDX] += LEARNING_RATE * err;
    this._trainedOn++;
  }

  /**
   * Predict P(correct | features).
   * Returns 0.5 (neutral) if the model has fewer than 10 training samples.
   */
  predict(
    confidence: number,
    tagAccuracy: number,
    sampleCount: number,
    trusted: boolean,
  ): number {
    if (this._trainedOn < 10) return 0.5; // insufficient data — stay neutral
    const x = this._features(confidence, tagAccuracy, sampleCount, trusted);
    return this._predict(x);
  }

  /**
   * Bulk-train from an existing record set.
   * Call this on startup to warm-start from persisted verdicts.
   */
  trainBulk(
    samples: Array<{
      confidence: number;
      tagAccuracy: number;
      sampleCount: number;
      trusted: boolean;
      isCorrect: boolean;
    }>,
  ): void {
    // Reset weights for clean bulk fit
    this.w = [0.0, 0.0, 0.0, 0.0, 0.0];
    this._trainedOn = 0;
    // Two passes for faster convergence
    for (let pass = 0; pass < 2; pass++) {
      for (const s of samples) {
        this.update(s.confidence, s.tagAccuracy, s.sampleCount, s.trusted, s.isCorrect);
      }
    }
  }

  private _features(
    confidence: number,
    tagAccuracy: number,
    sampleCount: number,
    trusted: boolean,
  ): [number, number, number, number] {
    return [
      Math.max(0, Math.min(1, confidence)),
      Math.max(0, Math.min(1, tagAccuracy)),
      Math.log(sampleCount + 1) / Math.log(500),
      trusted ? 1 : 0,
    ];
  }

  private _predict(x: [number, number, number, number]): number {
    let z = this.w[BIAS_IDX];
    for (let i = 0; i < 4; i++) z += this.w[i] * x[i];
    return sigmoid(z);
  }

  /** Serialise weights for diagnostics / export. */
  weights(): { w: number[]; trainedOn: number } {
    return { w: [...this.w], trainedOn: this._trainedOn };
  }
}

export const calibrationClassifier = new CalibrationClassifier();
