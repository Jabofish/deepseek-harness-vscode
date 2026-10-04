import { Rc172AccountLifecycleRepository } from '../rc172/account-repository.js'

/** Keep alpha.1's transport failure vocabulary behind the stable account port. */
export class Alpha211AccountLifecycleRepository extends Rc172AccountLifecycleRepository {
  protected override normalizeSignInErrorCode(value: unknown): unknown {
    return value === 'no-response' ? 'network' : super.normalizeSignInErrorCode(value)
  }
}
