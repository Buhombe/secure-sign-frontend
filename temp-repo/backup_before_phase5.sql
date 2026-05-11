--
-- PostgreSQL database dump
--

\restrict id3mujwFUuVFbpScQ4UFKBZrvpQKXVOhKlDGmkFz77LmEtlENF1Myma3gisUlbb

-- Dumped from database version 18.3 (Postgres.app)
-- Dumped by pg_dump version 18.3 (Postgres.app)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: milton
--

CREATE TABLE public.audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    document_id uuid,
    action character varying(100) NOT NULL,
    device_info text,
    ip_address character varying(45),
    "timestamp" timestamp with time zone DEFAULT now()
);


ALTER TABLE public.audit_logs OWNER TO milton;

--
-- Name: documents; Type: TABLE; Schema: public; Owner: milton
--

CREATE TABLE public.documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    original_name character varying(255) NOT NULL,
    file_path character varying(500) NOT NULL,
    status character varying(50) DEFAULT 'pending'::character varying,
    recipient_email character varying(254),
    recipient_token uuid,
    created_at timestamp with time zone DEFAULT now(),
    file_hash character varying(64),
    orig_file_path character varying(500),
    CONSTRAINT documents_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'signed'::character varying, 'revoked'::character varying])::text[])))
);


ALTER TABLE public.documents OWNER TO milton;

--
-- Name: refresh_tokens; Type: TABLE; Schema: public; Owner: milton
--

CREATE TABLE public.refresh_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash character varying(64) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.refresh_tokens OWNER TO milton;

--
-- Name: signatures; Type: TABLE; Schema: public; Owner: milton
--

CREATE TABLE public.signatures (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    user_id uuid,
    signer_email character varying(254),
    signature_hash character varying(64) NOT NULL,
    sig_x double precision DEFAULT 0,
    sig_y double precision DEFAULT 0,
    sig_width double precision DEFAULT 200,
    sig_height double precision DEFAULT 80,
    page_number integer DEFAULT 1,
    verified boolean DEFAULT false,
    verification_method character varying(100),
    signed_at timestamp with time zone DEFAULT now(),
    crypto_signature text,
    document_hash character varying(64)
);


ALTER TABLE public.signatures OWNER TO milton;

--
-- Name: users; Type: TABLE; Schema: public; Owner: milton
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email character varying(254) NOT NULL,
    password_hash character varying(255) NOT NULL,
    profile_photo text,
    created_at timestamp with time zone DEFAULT now(),
    failed_attempts integer DEFAULT 0 NOT NULL,
    lockout_until timestamp with time zone,
    mfa_enabled boolean DEFAULT false NOT NULL,
    mfa_secret text,
    mfa_secret_pending text,
    public_key text,
    private_key_enc text
);


ALTER TABLE public.users OWNER TO milton;

--
-- Data for Name: audit_logs; Type: TABLE DATA; Schema: public; Owner: milton
--

COPY public.audit_logs (id, user_id, document_id, action, device_info, ip_address, "timestamp") FROM stdin;
1847a157-666d-4770-b6a4-012b6a25f4af	c4269498-bfc8-47b2-b1f3-bf280218aa2d	\N	SIGNUP	curl/8.7.1	::1	2026-04-14 17:26:54.75519+03
8fb105db-7dff-4721-9127-b5334f8fae6d	c4269498-bfc8-47b2-b1f3-bf280218aa2d	\N	LOGIN	curl/8.7.1	::1	2026-04-14 17:32:43.89656+03
dceb8898-1d0d-4849-b185-b69edd9c761f	c4269498-bfc8-47b2-b1f3-bf280218aa2d	\N	LOGIN	curl/8.7.1	::1	2026-04-14 17:34:17.453094+03
a4d45514-923b-43f5-be33-777c8bf495d3	c4269498-bfc8-47b2-b1f3-bf280218aa2d	c3ffaf3c-2dd5-4f6a-85ed-c3bd0f6df8a7	UPLOAD	curl/8.7.1	::1	2026-04-14 17:35:44.243686+03
c69c400f-d40d-453f-a01a-8b83237c415b	c4269498-bfc8-47b2-b1f3-bf280218aa2d	c3ffaf3c-2dd5-4f6a-85ed-c3bd0f6df8a7	SIGN	curl/8.7.1	::1	2026-04-14 17:36:10.549284+03
bfa2ab19-64a7-4093-8dfe-d8682e787129	c4269498-bfc8-47b2-b1f3-bf280218aa2d	\N	LOGIN	curl/8.7.1	::1	2026-04-14 17:39:15.561191+03
100f52dd-a2bc-4ea2-a1ee-50aa40802a59	c4269498-bfc8-47b2-b1f3-bf280218aa2d	c3ffaf3c-2dd5-4f6a-85ed-c3bd0f6df8a7	VERIFY	\N	::1	2026-04-14 17:39:15.673404+03
944195c3-08ad-45a7-8047-f46beb94d185	c4269498-bfc8-47b2-b1f3-bf280218aa2d	\N	LOGIN	curl/8.7.1	::1	2026-04-14 17:40:48.126679+03
66eb6aea-a057-4a00-94e7-2d3311a79688	c4269498-bfc8-47b2-b1f3-bf280218aa2d	b283a3e8-1c26-48ad-85eb-9f8672112efb	UPLOAD	curl/8.7.1	::1	2026-04-14 17:40:48.253555+03
fb84bd5d-d64b-4811-93e9-3bfb7647ef43	c4269498-bfc8-47b2-b1f3-bf280218aa2d	b283a3e8-1c26-48ad-85eb-9f8672112efb	SIGN	curl/8.7.1	::1	2026-04-14 17:40:48.375604+03
002b4303-7460-4b12-b118-b8448d674be0	c4269498-bfc8-47b2-b1f3-bf280218aa2d	b283a3e8-1c26-48ad-85eb-9f8672112efb	VERIFY	\N	::1	2026-04-14 17:40:48.49021+03
46d61791-512b-482f-b0f4-38640abc9e4f	c4269498-bfc8-47b2-b1f3-bf280218aa2d	\N	LOGIN	curl/8.7.1	::1	2026-04-14 17:43:38.756542+03
030d5782-7c7c-4bf3-bd3a-b389db1c06f3	c4269498-bfc8-47b2-b1f3-bf280218aa2d	1ef68ccf-5541-45a7-8241-32e5bb92c27b	UPLOAD	curl/8.7.1	::1	2026-04-14 17:43:38.857788+03
6dd0f484-16bb-4d93-b2cf-6d071671c6ea	c4269498-bfc8-47b2-b1f3-bf280218aa2d	1ef68ccf-5541-45a7-8241-32e5bb92c27b	SIGN	curl/8.7.1	::1	2026-04-14 17:43:38.971738+03
996f1a0c-ecc6-4a9b-9c94-deff8280d064	c4269498-bfc8-47b2-b1f3-bf280218aa2d	1ef68ccf-5541-45a7-8241-32e5bb92c27b	VERIFY	\N	::1	2026-04-14 17:43:39.071526+03
f2113820-a652-473d-bcb2-5cf263a9727d	c4269498-bfc8-47b2-b1f3-bf280218aa2d	\N	LOGIN	curl/8.7.1	::1	2026-04-14 17:46:59.93377+03
fb37655d-1802-4ff4-9b30-9d345fe5de1a	c4269498-bfc8-47b2-b1f3-bf280218aa2d	47f31ede-6955-4c81-85b1-7abe0144ba9d	UPLOAD	curl/8.7.1	::1	2026-04-14 17:47:00.033827+03
5054f78c-e6b3-48d7-8099-da9e1e076fb0	c4269498-bfc8-47b2-b1f3-bf280218aa2d	47f31ede-6955-4c81-85b1-7abe0144ba9d	SIGN	curl/8.7.1	::1	2026-04-14 17:47:00.165073+03
4eb8fb9c-3492-43ca-a3fc-df5b05ca0502	c4269498-bfc8-47b2-b1f3-bf280218aa2d	47f31ede-6955-4c81-85b1-7abe0144ba9d	VERIFY	\N	::1	2026-04-14 17:47:00.252982+03
\.


--
-- Data for Name: documents; Type: TABLE DATA; Schema: public; Owner: milton
--

COPY public.documents (id, user_id, original_name, file_path, status, recipient_email, recipient_token, created_at, file_hash, orig_file_path) FROM stdin;
c3ffaf3c-2dd5-4f6a-85ed-c3bd0f6df8a7	c4269498-bfc8-47b2-b1f3-bf280218aa2d	test.pdf	signed-7c48fc17-f388-4661-ae0d-1a3c9abb08e5.pdf	signed	\N	\N	2026-04-14 17:35:44.185894+03	9dc877c07ef3475cc9a773174f98154d8f4debbc7f717d804a8a1d00b950fae4	\N
b283a3e8-1c26-48ad-85eb-9f8672112efb	c4269498-bfc8-47b2-b1f3-bf280218aa2d	test.pdf	signed-3d643ebf-3deb-4047-bdd0-7961cf437cc4.pdf	signed	\N	\N	2026-04-14 17:40:48.193718+03	8e649b8d29f29a6ff54d329e8e82e352bedf59691504bed344d3fc7f6637d9d2	\N
1ef68ccf-5541-45a7-8241-32e5bb92c27b	c4269498-bfc8-47b2-b1f3-bf280218aa2d	test.pdf	signed-a5191d1c-3607-4383-9477-c79efe1cf8e1.pdf	signed	\N	\N	2026-04-14 17:43:38.8134+03	f0bd253cebdda8836471144ee1b89efee1f4ac7587d0d2de9e1ca26f97984839	\N
47f31ede-6955-4c81-85b1-7abe0144ba9d	c4269498-bfc8-47b2-b1f3-bf280218aa2d	test.pdf	signed-18200487-5955-4366-a032-6a13e439978b.pdf	signed	\N	\N	2026-04-14 17:46:59.989009+03	098d15a5e6ae9d7ded0c8ccb43551348fb3cc466e908634ab0ab9d446cdec695	orig-948457e5-64d0-40e2-a688-2bff1039ceed.pdf
\.


--
-- Data for Name: refresh_tokens; Type: TABLE DATA; Schema: public; Owner: milton
--

COPY public.refresh_tokens (id, user_id, token_hash, expires_at, revoked, created_at) FROM stdin;
eb04da49-b8f4-45fc-9960-31e7135537b4	c4269498-bfc8-47b2-b1f3-bf280218aa2d	80bb861d1711eb75642cfebac7459921410a7195abc9192959b880373e5a1617	2026-04-21 17:26:54.834+03	f	2026-04-14 17:26:54.835325+03
01d8503c-caff-47ff-9bc9-32520f1d7d92	c4269498-bfc8-47b2-b1f3-bf280218aa2d	97eec8ea4e79297ef155f6d5af87cfc9d7910196c12c31bae4e17b5bb70f5878	2026-04-21 17:32:43.902+03	f	2026-04-14 17:32:43.903058+03
fdfd4a2a-b4b7-40c8-a363-75814893210a	c4269498-bfc8-47b2-b1f3-bf280218aa2d	14a0870bdec90bbea6412c32e2f44ce83345c3ff0242de92c1882438ef86c8d0	2026-04-21 17:34:17.457+03	f	2026-04-14 17:34:17.457728+03
e1cdb6e4-eb9a-4877-b159-61999c4d84c5	c4269498-bfc8-47b2-b1f3-bf280218aa2d	fa34426e560b3c0148881cfd51c4e7e7219697dab94cfefc18b196993e12ead9	2026-04-21 17:39:15.575+03	f	2026-04-14 17:39:15.576465+03
146de5c0-57aa-48d7-8c7b-19da37357d1a	c4269498-bfc8-47b2-b1f3-bf280218aa2d	7ddbd4c2c15123fec5e66d8ed2f137c91d9daea0f29ca98b5c6d30943c5cd6cd	2026-04-21 17:40:48.135+03	f	2026-04-14 17:40:48.136535+03
5c10c1b8-f5ff-4a9b-a500-17037f658e52	c4269498-bfc8-47b2-b1f3-bf280218aa2d	d92b3dcf8c8d2fa543c7d7bc859cb333db6122b55d8aa22aabd1a8e09b709893	2026-04-21 17:43:38.764+03	f	2026-04-14 17:43:38.766197+03
03505814-ea19-4c1f-b713-0853415fa95e	c4269498-bfc8-47b2-b1f3-bf280218aa2d	631636ce25c10c1d22302fc54e664a3200315bc105285d3802bd4d0ea16fb8fe	2026-04-21 17:46:59.941+03	f	2026-04-14 17:46:59.942481+03
\.


--
-- Data for Name: signatures; Type: TABLE DATA; Schema: public; Owner: milton
--

COPY public.signatures (id, document_id, user_id, signer_email, signature_hash, sig_x, sig_y, sig_width, sig_height, page_number, verified, verification_method, signed_at, crypto_signature, document_hash) FROM stdin;
8fd0be87-5ab2-47ec-ac9b-589e3ab4e5dd	c3ffaf3c-2dd5-4f6a-85ed-c3bd0f6df8a7	c4269498-bfc8-47b2-b1f3-bf280218aa2d	test@securesign.com	6b7fa434f92a8b80aab02d9bf1a12e49ffcae424e4013a1c4f68b67e3d2bbcd0	10	80	200	80	1	t	RSA-PSS-SHA256	2026-04-14 17:36:10.549284+03	5f4ca82d9f97d4be4c895c6ace22052d90929e401f2a88cde410316c7228134ee47df75eaa20fa935e0bac4a08e4806da0ba6efe1b6c6b7f9a703bcc2ae7d88afb13cb6e0ef17ccf8d9939750d6d39ee8fcf458f7918693db5ff55e20930dfa8547cef6da8eb18e8a0e2450fd04f83f87ac7f5cff2e4129bfcec8aa6d8fa79d8d21b2d0b8fe7a9321c6292432afc2521d589c806dbb984fd776e44027178e38ea958e08d48bd0ab8bc5b001d69b20958bb0c2e0654bfb16efc0d801d9a994b48fb0407c785584fd395469b3838110106116e8d85235c1eeda0e7f196efb9bf2629662b9a1583b4aed2379344ffadcbc3042f8e1ce2e03081490ed16e9fad3641	d55782fae6e6a29215f43338408044c349e4096b6e9735446163ff714f65496b
1f946d99-34aa-4b95-9b8a-396a9f7039c8	b283a3e8-1c26-48ad-85eb-9f8672112efb	c4269498-bfc8-47b2-b1f3-bf280218aa2d	test@securesign.com	6b7fa434f92a8b80aab02d9bf1a12e49ffcae424e4013a1c4f68b67e3d2bbcd0	10	80	200	80	1	t	RSA-PSS-SHA256	2026-04-14 17:40:48.375604+03	3bdadf7f1727362cfe6280aec4d65129c01f17988506d4c8736fd202b1d1a763d7808f439eb50d184502d96e502ed97a14e6fe7a2ed53a8d8c993b87ed4085e7576da81df0104d899a85b4749b78d683084af4b4fb5ad18ecf40a873ed3fdcb5e7524b9e3941f14202e1612187b1fa23327a59a5e06fb922071f48b1ce48956098d41e451e8f8bab1e2e55ccc9e054da7c8453547a11d7394a8019793c6b2ab5aaff12b8c57500a8ed7f0c0cb4cb3534044aea79f487a47bdc221c00e9b0bdec5bb8588466e393b62f30c46c951ee935cfdea5b958db727d7ee0977ea3bc91dc4cd5d01db68a97306896f9c3b886e9f885166ab8d2c0586645bfd8a0d8b488b7	d55782fae6e6a29215f43338408044c349e4096b6e9735446163ff714f65496b
7888be9d-8923-43eb-9cc4-57f03fa43108	1ef68ccf-5541-45a7-8241-32e5bb92c27b	c4269498-bfc8-47b2-b1f3-bf280218aa2d	test@securesign.com	6b7fa434f92a8b80aab02d9bf1a12e49ffcae424e4013a1c4f68b67e3d2bbcd0	10	80	200	80	1	t	RSA-PSS-SHA256	2026-04-14 17:43:38.971738+03	6a27dd2db006295c488b49692ebf893d15d81e6db5df92d4fa669a1c696a5e5b76e92dfb73552aa3d1ed80a694de61bd686e2606e091b1bf81e6081b9affd89fa7bc71a0d7d7b60fbedb3aafd35918f01035f9d9e98d63517366225635bd13720eaa376f2c6a25f89b30cce42f52522baf8fa6588cd0c3e181a63d2ffe4a3efaadbf8b41a6099c5a608057e57a6e168ee9c03456fce7099eb801a7798a320970fa8da12e5ef050e086f0d2998dd05e631f5e848775439a482a63cc29764294bc5cbd1e9e699bacb9cbb9c3da2c54eee8deb530425034775256e0c32feddac64307e9c4cc434aacea34fcf81871ef9923dc8bba9be15c2975f92b58dc7c603903	d55782fae6e6a29215f43338408044c349e4096b6e9735446163ff714f65496b
e53f43fb-1a82-4a7e-a34c-e14e00ae9e3f	47f31ede-6955-4c81-85b1-7abe0144ba9d	c4269498-bfc8-47b2-b1f3-bf280218aa2d	test@securesign.com	6b7fa434f92a8b80aab02d9bf1a12e49ffcae424e4013a1c4f68b67e3d2bbcd0	10	80	200	80	1	t	RSA-PSS-SHA256	2026-04-14 17:47:00.165073+03	3f7b4f558fbcd2d43376381d6dd263eebf01914669371ad5ee6434384b0be3ed71050d35a60847df10e50590656e6df3ee4a72d25a7884e7a5c7748dcba724c92ddf6fb78aca99bbf5e6d54f73a9f4b6ff9c3d7b5d395992e0d530f586335c0a5595f372e97047b86a0ce61bf02ef351ca160beeb7d02350cec3cd89096a83bc19101f58a7fad5e7ee78203379569fc156ddfb3232cf25f283cbd3a959341c6eb3e70b3a19ec41399ec28cf6c4f029d18bef503e93e70de29c826aaa35b2ec54eaa9e9d871b73882475236bdfbb9120162341bbce2c996703d8bf73b23514083361c557afeb5f3e66ef3cdd15e04f32d8543275e909fb6d7e3606fcf7a1495dc	d55782fae6e6a29215f43338408044c349e4096b6e9735446163ff714f65496b
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: milton
--

COPY public.users (id, email, password_hash, profile_photo, created_at, failed_attempts, lockout_until, mfa_enabled, mfa_secret, mfa_secret_pending, public_key, private_key_enc) FROM stdin;
c4269498-bfc8-47b2-b1f3-bf280218aa2d	test@securesign.com	$2a$12$QPPDJktdggbxZjj7yABjyOZgmU84OM5tANUzsbFXaLpFB2qk862V.	\N	2026-04-14 17:26:54.746176+03	0	\N	f	\N	\N	-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAv2Lwjjz4fyPcefa+SFim\nAn2oGJ5+PRtG8VCscSVB/QaIgvOmqeNZ9TZIv8uCNe+HlKoQrbAdvDW7CQVbDaNs\ntT3lK0kKs9QFadFmKJYjroDSojyWAH7XQy9B0EuxW4BZ7CIzyUrEtiIXob5PPBmj\nh9wyZ+SB9yzZjAzcuJ2latKLIlyauxGzSyWMUiLp4R3Y07auzxMNEB/Dy7qgzWOc\ng6krM/kGnx1lHY/ABkYIsNdfBL6XGCvl61rdP5I291hJpFSu38/hhlCWHkMJPcpC\nsBYXI0sBNa4K85WjlA0G41dWMcXsKzEKgNW/UB6M+q8bTvTSL5ud8SslxGiRheVQ\n/QIDAQAB\n-----END PUBLIC KEY-----\n	v1:ff51c29dea349b4fef1003e1:b6d51775face73b6bbaf63eb93ccc575:acba037dd297a0f18329bb64d07e5a3e307c273a0629a6710dfd1f2f2e78734f26bf0ed1e99a1473acc922128b7a16f844a8872de0198659154885c617eb64b41d2d4dfd775a05fa503152207c3a3b184498b0391e3c774ae1936396f4bc6508e34246a7e52bceb3fc50652358906790bb8841a65dbd8784120b3ec60b5e65fde08f4d57fb126ef15e8610d355a4113c94689de4025bdf5c8cdb519c523a5a0e7d02b39b4a3fbdc11a18c7157bd4b79509efa86f20e8889bc3e65890097569eba47f3d529ec483b365ecab95dc2828f61ef3c47c93a0d9d1565b2c3bd7b9ea32e2995d4b3d0d4e766a0de277dc5e6264e641f7c1e2d4b8342ce8e39714bbfc837a752e512643006a25624c5a3914ea15dd60252884a2bf81b556b52f6c9fe37e3941f85979f6f2ab035f995f5e1398e267ea99b93fce63b787e01a832be99156cc8f1d14acb75b195e42093bcbd488bdef0f8a047f1f241e6b1f01ed6630fbddbe989fa7ad668d5f022253410f8c9c1aa7231b7e9842b6e58d9f7f0c8330b298bfb26e3ad3b531ad4d0ff9d0781619e024c5ca1311871612670e5c2ca7215ac2dbca7758b62f70f779bceb46c01443056c41d5010242f173f7565757cbf46318943d4ad7ec0fde403f1935aeae33a076f987ad8c7ebc2f31d13ec748ac48d71432bad09b2e19a4a8e30b85d57aa334faf5162047428a10017536f6e024088e7a93fae128aaac79982af710580023f2aeb60d1b9b5aa5cb213afc31e3e147d506c60e8cc43b600e0661aa87baab0b48c8f61f51fed543c138351d03f4f8f084fb6785a578ab6d9bd330bbe8f90295baf8e0984a2ec038ab91c852d2af4afe0405346528ea67ddacb355d77d8f75f3cec72fec6a72ed04d74c8ea059383273c9cc492d7ee7fb0f0cd1680df92ec4735b0070200fb1f21991f1443145de7d12fd5e54df65a16ff0ccadf6e747875c29f2e193f4ba0f562b7cc818364da6d53505e16e3c3b37b42953bfdd207874a129f8260e67404088873eba31efb6aca303e3f64ab1419627a7607a8638c270b7b24a57efcd9def093dbb0e7ba24f6e481c401d57ce86f4a28eab8c8aa57ad5f52580d5696fb173194fe5e15a1ffeb3e83ee4489ad9d405c8d49c8bce3e217c3eeeb85797beb2a57348f2abb8f1668a80ca661095fd31baa7d28f0cb773ec5dd52b8a1265ae04420161853b5bb84c69a3135562a45d3377bf35ec8e5987366b3f17e4055a33deaa915e3db80893633654bee3c5961f56115ba62aa2b65881c1adc72f19cb04cc693b0a1fe9e162d30563df0fa780dac745b471b2ae6a9ab36fd31fe3c5249ef9d0f562490a1f63070584e6ba3fff80cdcda90d6479835d22db03b8997e3189bc6317d32e2548e12cba2630c0bc26c21ef5b3a5acb43bdd39b72fca8ad77ba3e9778cf5beef6b0bb84e6edf6586dbff5f39ef6372e02a269db00904a526ca4b2fb061e77d8394de5ae1a317380afe2cc28d7e29a109e8fbb4ffd9cebef7e9e62d15df16a33a83df780e1f87a6255a93e900cbcab56fb1dae0d1b9dbe92b7a15d9f8709fe3360a88c5f43709d565ee58ef80f08ab135ab7ee0a7cb3232f5a9d01b42649577158a1784f0a44fe338c94eef474f688d2d384f081a6eed8ae9e3bad92a0ba7e52fe626bd1c7c4aa048d333704bfb369059c07fded77c0ce6c405c6940292b453af76b710ff0d61c6d9a092d06132ae87bc7b7671fbbd413ae10a2f5e82007a94aa8a378b0679d4ac1d82a48c5a2d9725515d7f282271b9cbbdcdf429ab4391309d7d6df7a9f098857a9d81ab62858b5d134a21cfca8c07359afe74f14eef07512c65a191764aa15f6018bf464f5b32903b2290414caf917396d68b1f0242f98b293afb9e1bebdfff83268abf385c676ff29b689b750ef03250ea2cd049864f2fe57d64a676eec4e4468e9a3bf3c65099440cd7e424a5feae012a3e32a43adf0ecaf8326ff0ebeb51101d0e774c3910cdfa0c09051b0073095e0a083e8b08870ddc01a805d6b7680ec2392a8083dfe5b4261ee6b28177838aa66a1913f1e733ea43ed9cade721e82f8f8ba2535eefd6c039ff243007a4c851bbd6f0e01d7b3530e442da012481449490f15fa014723c8968b952802d53af7f1f799c88cf389d9308cc9f48e9843ef0ec9c373fd8e4f6ed7a61e252dd2c8cb3387d51952cb4024b004274875699d55726bf028eea9ebc666c4e09bb1c40e52f2bbab8cc7020c4900c339025ff9db46c1f4b011073c921e283af075a64c5eacbdd3bc2eace79d6a272d81d3cda37b352775e2d30e472a86194deacd3f8251abf7c801b82c98c977a2b025898abde0dcfd30d32f2ac76da8055ee031757de41f49a6acb8b234c4ba87e92bda0f2a4e1d1d834a29ba92a56d473
\.


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: milton
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: milton
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: milton
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: milton
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: signatures signatures_pkey; Type: CONSTRAINT; Schema: public; Owner: milton
--

ALTER TABLE ONLY public.signatures
    ADD CONSTRAINT signatures_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: milton
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: milton
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: idx_audit_document_id; Type: INDEX; Schema: public; Owner: milton
--

CREATE INDEX idx_audit_document_id ON public.audit_logs USING btree (document_id);


--
-- Name: idx_audit_user_id; Type: INDEX; Schema: public; Owner: milton
--

CREATE INDEX idx_audit_user_id ON public.audit_logs USING btree (user_id);


--
-- Name: idx_documents_file_hash; Type: INDEX; Schema: public; Owner: milton
--

CREATE INDEX idx_documents_file_hash ON public.documents USING btree (file_hash);


--
-- Name: idx_documents_recipient_token; Type: INDEX; Schema: public; Owner: milton
--

CREATE INDEX idx_documents_recipient_token ON public.documents USING btree (recipient_token);


--
-- Name: idx_documents_user_id; Type: INDEX; Schema: public; Owner: milton
--

CREATE INDEX idx_documents_user_id ON public.documents USING btree (user_id);


--
-- Name: idx_refresh_tokens_expires; Type: INDEX; Schema: public; Owner: milton
--

CREATE INDEX idx_refresh_tokens_expires ON public.refresh_tokens USING btree (expires_at);


--
-- Name: idx_refresh_tokens_hash; Type: INDEX; Schema: public; Owner: milton
--

CREATE INDEX idx_refresh_tokens_hash ON public.refresh_tokens USING btree (token_hash);


--
-- Name: idx_refresh_tokens_user; Type: INDEX; Schema: public; Owner: milton
--

CREATE INDEX idx_refresh_tokens_user ON public.refresh_tokens USING btree (user_id);


--
-- Name: idx_signatures_document; Type: INDEX; Schema: public; Owner: milton
--

CREATE INDEX idx_signatures_document ON public.signatures USING btree (document_id);


--
-- Name: idx_signatures_document_hash; Type: INDEX; Schema: public; Owner: milton
--

CREATE INDEX idx_signatures_document_hash ON public.signatures USING btree (document_hash);


--
-- Name: idx_signatures_signer; Type: INDEX; Schema: public; Owner: milton
--

CREATE INDEX idx_signatures_signer ON public.signatures USING btree (signer_email);


--
-- Name: audit_logs audit_logs_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: milton
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE SET NULL;


--
-- Name: audit_logs audit_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: milton
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: documents documents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: milton
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: refresh_tokens refresh_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: milton
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: signatures signatures_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: milton
--

ALTER TABLE ONLY public.signatures
    ADD CONSTRAINT signatures_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: signatures signatures_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: milton
--

ALTER TABLE ONLY public.signatures
    ADD CONSTRAINT signatures_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict id3mujwFUuVFbpScQ4UFKBZrvpQKXVOhKlDGmkFz77LmEtlENF1Myma3gisUlbb

