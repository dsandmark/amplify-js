import { ConsoleLogger as Logger } from './Logger';
import { StorageHelper } from './StorageHelper';
import { makeQuerablePromise } from './JS';
import { FacebookOAuth, GoogleOAuth } from './OAuthHelper';
import { ICredentials } from './types';
import { getAmplifyUserAgent } from './Platform';
import { Amplify } from './Amplify';
import {
	fromCognitoIdentity,
	FromCognitoIdentityParameters,
	fromCognitoIdentityPool,
	FromCognitoIdentityPoolParameters,
} from '@aws-sdk/credential-provider-cognito-identity';
import {
	CognitoIdentityClient,
	GetIdCommand,
} from '@aws-sdk/client-cognito-identity';
import { CredentialProvider } from '@aws-sdk/types';

const logger = new Logger('Credentials');

const CREDENTIALS_TTL = 50 * 60 * 1000; // 50 min, can be modified on config if required in the future

export class CredentialsClass {
	private _config;
	private _credentials;
	private _credentials_source;
	private _gettingCredPromise = null;
	private _refreshHandlers = {};
	private _storage;
	private _storageSync;
	private _identityId;
	private _nextCredentialsRefresh: Number;

	constructor(config) {
		this.configure(config);
		this._refreshHandlers['google'] = GoogleOAuth.refreshGoogleToken;
		this._refreshHandlers['facebook'] = FacebookOAuth.refreshFacebookToken;
	}

	public getCredSource() {
		return this._credentials_source;
	}

	public configure(config) {
		if (!config) return this._config || {};

		this._config = Object.assign({}, this._config, config);
		const { refreshHandlers } = this._config;
		// If the developer has provided an object of refresh handlers,
		// then we can merge the provided handlers with the current handlers.
		if (refreshHandlers) {
			this._refreshHandlers = { ...this._refreshHandlers, ...refreshHandlers };
		}

		this._storage = this._config.storage;
		if (!this._storage) {
			this._storage = new StorageHelper().getStorage();
		}

		this._storageSync = Promise.resolve();
		if (typeof this._storage['sync'] === 'function') {
			this._storageSync = this._storage['sync']();
		}

		return this._config;
	}

	public get() {
		logger.debug('getting credentials');
		return this._pickupCredentials();
	}

	private _pickupCredentials() {
		logger.debug('picking up credentials');
		if (!this._gettingCredPromise || !this._gettingCredPromise.isPending()) {
			logger.debug('getting new cred promise');
			this._gettingCredPromise = makeQuerablePromise(this._keepAlive());
		} else {
			logger.debug('getting old cred promise');
		}
		return this._gettingCredPromise;
	}

	private _keepAlive() {
		logger.debug('checking if credentials exists and not expired');
		const cred = this._credentials;
		if (cred && !this._isExpired(cred)) {
			logger.debug('credentials not changed and not expired, directly return');
			return Promise.resolve(cred);
		}

		logger.debug('need to get a new credential or refresh the existing one');
		if (
			Amplify.Auth &&
			typeof Amplify.Auth.currentUserCredentials === 'function'
		) {
			return Amplify.Auth.currentUserCredentials();
		} else {
			return Promise.reject('No Auth module registered in Amplify');
		}
	}

	public refreshFederatedToken(federatedInfo) {
		logger.debug('Getting federated credentials');
		const { provider, user } = federatedInfo;
		let token = federatedInfo.token;
		let expires_at = federatedInfo.expires_at;

		// Make sure expires_at is in millis
		expires_at =
			new Date(expires_at).getFullYear() === 1970
				? expires_at * 1000
				: expires_at;

		const that = this;
		logger.debug('checking if federated jwt token expired');
		if (expires_at > new Date().getTime()) {
			// if not expired
			logger.debug('token not expired');
			return this._setCredentialsFromFederation({
				provider,
				token,
				user,
				expires_at,
			});
		} else {
			// if refresh handler exists
			if (
				that._refreshHandlers[provider] &&
				typeof that._refreshHandlers[provider] === 'function'
			) {
				logger.debug('getting refreshed jwt token from federation provider');
				return that._refreshHandlers[provider]()
					.then(data => {
						logger.debug('refresh federated token sucessfully', data);
						token = data.token;
						expires_at = data.expires_at;

						return that._setCredentialsFromFederation({
							provider,
							token,
							user,
							expires_at,
						});
					})
					.catch(e => {
						logger.debug('refresh federated token failed', e);
						this.clear();
						return Promise.reject('refreshing federation token failed: ' + e);
					});
			} else {
				logger.debug('no refresh handler for provider:', provider);
				this.clear();
				return Promise.reject('no refresh handler for provider');
			}
		}
	}

	private _isExpired(credentials): boolean {
		if (!credentials) {
			logger.debug('no credentials for expiration check');
			return true;
		}
		logger.debug('are these credentials expired?', credentials);
		const ts = Date.now();
		const delta = 10 * 60 * 1000; // 10 minutes in milli seconds

		/* returns date object.
			https://github.com/aws/aws-sdk-js-v3/blob/v1.0.0-beta.1/packages/types/src/credentials.ts#L26
		*/
		const { expiration } = credentials;
		if (
			expiration.getTime() > ts + delta &&
			ts < this._nextCredentialsRefresh
		) {
			return false;
		}
		return true;
	}

	private async _setCredentialsForGuest() {
		logger.debug('setting credentials for guest');
		const { identityPoolId, region, mandatorySignIn } = this._config;
		if (mandatorySignIn) {
			return Promise.reject(
				'cannot get guest credentials when mandatory signin enabled'
			);
		}

		if (!identityPoolId) {
			logger.debug(
				'No Cognito Identity pool provided for unauthenticated access'
			);
			return Promise.reject(
				'No Cognito Identity pool provided for unauthenticated access'
			);
		}

		if (!region) {
			logger.debug('region is not configured for getting the credentials');
			return Promise.reject(
				'region is not configured for getting the credentials'
			);
		}

		let identityId = undefined;
		try {
			await this._storageSync;
			identityId = this._storage.getItem('CognitoIdentityId-' + identityPoolId);
			this._identityId = identityId;
		} catch (e) {
			logger.debug('Failed to get the cached identityId', e);
		}

		const cognitoClient = new CognitoIdentityClient({
			region,
			credentials: () => Promise.resolve({} as any),
			customUserAgent: getAmplifyUserAgent(),
		});

		let credentials = undefined;
		if (identityId && identityId !== 'undefined') {
			const cognitoIdentityParams: FromCognitoIdentityParameters = {
				identityId,
				client: cognitoClient,
			};
			credentials = fromCognitoIdentity(cognitoIdentityParams)();
		} else {
			/*
			Retreiving identityId with GetIdCommand to mimic the behavior in the following code in aws-sdk-v3:
			https://git.io/JeDxU

			Note: Retreive identityId from CredentialsProvider once aws-sdk-js v3 supports this.
			*/
			const credentialsProvider: CredentialProvider = async () => {
				const { IdentityId } = await cognitoClient.send(
					new GetIdCommand({
						IdentityPoolId: identityPoolId,
					})
				);
				this._identityId = IdentityId;
				const cognitoIdentityParams: FromCognitoIdentityParameters = {
					client: cognitoClient,
					identityId: IdentityId,
				};

				const credentialsFromCognitoIdentity = fromCognitoIdentity(
					cognitoIdentityParams
				);

				return credentialsFromCognitoIdentity();
			};

			credentials = credentialsProvider().catch(async err => {
				throw err;
			});
		}

		return this._loadCredentials(credentials, 'guest', false, null)
			.then(res => {
				return res;
			})
			.catch(async e => {
				return e;
			});
	}

	private _setCredentialsFromFederation(params) {
		const { provider, token } = params;
		const domains = {
			google: 'accounts.google.com',
			facebook: 'graph.facebook.com',
			amazon: 'www.amazon.com',
			developer: 'cognito-identity.amazonaws.com',
		};

		// Use custom provider url instead of the predefined ones
		const domain = domains[provider] || provider;
		if (!domain) {
			return Promise.reject('You must specify a federated provider');
		}

		const logins = {};
		logins[domain] = token;

		const { identityPoolId, region } = this._config;
		if (!identityPoolId) {
			logger.debug('No Cognito Federated Identity pool provided');
			return Promise.reject('No Cognito Federated Identity pool provided');
		}
		if (!region) {
			logger.debug('region is not configured for getting the credentials');
			return Promise.reject(
				'region is not configured for getting the credentials'
			);
		}

		const cognitoClient = new CognitoIdentityClient({
			region,
			credentials: () => Promise.resolve({} as any),
			customUserAgent: getAmplifyUserAgent(),
		});
		const cognitoIdentityParams: FromCognitoIdentityPoolParameters = {
			logins,
			identityPoolId,
			client: cognitoClient,
		};
		const credentials = fromCognitoIdentityPool(cognitoIdentityParams)();

		return this._loadCredentials(credentials, 'federated', true, params);
	}

	private _setCredentialsFromSession(session): Promise<ICredentials> {
		logger.debug('set credentials from session');
		const idToken = session.getIdToken().getJwtToken();
		const { region, userPoolId, identityPoolId } = this._config;
		if (!identityPoolId) {
			logger.debug('No Cognito Federated Identity pool provided');
			return Promise.reject('No Cognito Federated Identity pool provided');
		}
		if (!region) {
			logger.debug('region is not configured for getting the credentials');
			return Promise.reject(
				'region is not configured for getting the credentials'
			);
		}
		const key = 'cognito-idp.' + region + '.amazonaws.com/' + userPoolId;
		const logins = {};
		logins[key] = idToken;

		const cognitoClient = new CognitoIdentityClient({
			region,
			credentials: () => Promise.resolve({} as any),
			customUserAgent: getAmplifyUserAgent(),
		});

		/* 
			Retreiving identityId with GetIdCommand to mimic the behavior in the following code in aws-sdk-v3:
			https://git.io/JeDxU

			Note: Retreive identityId from CredentialsProvider once aws-sdk-js v3 supports this.
		*/
		const credentialsProvider: CredentialProvider = async () => {
			const { IdentityId } = await cognitoClient.send(
				new GetIdCommand({
					IdentityPoolId: identityPoolId,
					Logins: logins,
				})
			);
			this._identityId = IdentityId;

			const cognitoIdentityParams: FromCognitoIdentityParameters = {
				client: cognitoClient,
				logins,
				identityId: IdentityId,
			};

			const credentialsFromCognitoIdentity = fromCognitoIdentity(
				cognitoIdentityParams
			);

			return credentialsFromCognitoIdentity();
		};

		const credentials = credentialsProvider().catch(async err => {
			throw err;
		});

		return this._loadCredentials(credentials, 'userPool', true, null);
	}

	private _loadCredentials(
		credentials,
		source,
		authenticated,
		info
	): Promise<ICredentials> {
		const that = this;
		const { identityPoolId } = this._config;
		return new Promise((res, rej) => {
			credentials
				.then(async credentials => {
					logger.debug('Load credentials successfully', credentials);
					if (this._identityId && !credentials.identityId) {
						credentials['identityId'] = this._identityId;
					}

					that._credentials = credentials;
					that._credentials.authenticated = authenticated;
					that._credentials_source = source;
					that._nextCredentialsRefresh = new Date().getTime() + CREDENTIALS_TTL;
					if (source === 'federated') {
						const user = info.user;
						const { provider, token, expires_at } = info;
						try {
							this._storage.setItem(
								'aws-amplify-federatedInfo',
								JSON.stringify({
									provider,
									token,
									user,
									expires_at,
								})
							);
						} catch (e) {
							logger.debug('Failed to put federated info into auth storage', e);
						}
					}
					if (source === 'guest') {
						try {
							await this._storageSync;
							this._storage.setItem(
								'CognitoIdentityId-' + identityPoolId,
								credentials.identityId // TODO: IdentityId is currently not returned by fromCognitoIdentityPool()
							);
						} catch (e) {
							logger.debug('Failed to cache identityId', e);
						}
					}
					res(that._credentials);
					return;
				})
				.catch(err => {
					if (err) {
						logger.debug('Failed to load credentials', credentials);
						rej(err);
						return;
					}
				});
		});
	}

	public set(params, source): Promise<ICredentials> {
		if (source === 'session') {
			return this._setCredentialsFromSession(params);
		} else if (source === 'federation') {
			return this._setCredentialsFromFederation(params);
		} else if (source === 'guest') {
			return this._setCredentialsForGuest();
		} else {
			logger.debug('no source specified for setting credentials');
			return Promise.reject('invalid source');
		}
	}

	public async clear() {
		this._credentials = null;
		this._credentials_source = null;
		this._storage.removeItem('aws-amplify-federatedInfo');
	}

	/**
	 * Compact version of credentials
	 * @param {Object} credentials
	 * @return {Object} - Credentials
	 */
	public shear(credentials) {
		return {
			accessKeyId: credentials.accessKeyId,
			sessionToken: credentials.sessionToken,
			secretAccessKey: credentials.secretAccessKey,
			identityId: credentials.identityId,
			authenticated: credentials.authenticated,
		};
	}
}

export const Credentials = new CredentialsClass(null);

/**
 * @deprecated use named import
 */
export default Credentials;
