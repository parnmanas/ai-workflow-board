import { helper } from './utility';

export class SmokeService {
  run(value: string): string {
    return helper(value);
  }
}
