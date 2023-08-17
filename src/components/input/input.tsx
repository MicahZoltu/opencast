import { UserAvatar } from '@components/user/user-avatar';
import { Message } from '@farcaster/hub-web';
import { useAuth } from '@lib/context/auth-context';
import type { FilesWithId, ImageData, ImagesPreview } from '@lib/types/file';
import type { User } from '@lib/types/user';
import { getHttpsUrls, sleep } from '@lib/utils';
import { getImagesData } from '@lib/validation';
import cn from 'clsx';
import type { Variants } from 'framer-motion';
import { AnimatePresence, motion } from 'framer-motion';
import Link from 'next/link';
import type { ChangeEvent, ClipboardEvent, FormEvent, ReactNode } from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';
import { createCastMessage, submitHubMessage } from '../../lib/farcaster/utils';
import { ImagePreview } from './image-preview';
import { fromTop, InputForm } from './input-form';
import { InputOptions } from './input-options';
import { uploadToImgur } from '../../lib/imgur/upload';
import { ExternalEmbed } from '../../lib/types/tweet';
import useSWR from 'swr';
import { fetchJSON } from '../../lib/fetch';
import { TweetEmbed, TweetEmbeds } from '../tweet/tweet-embed';
import { debounce } from 'lodash';

type InputProps = {
  modal?: boolean;
  reply?: boolean;
  parent?: { id: string; username: string; userId: string };
  disabled?: boolean;
  children?: ReactNode;
  replyModal?: boolean;
  parentUrl?: string;
  closeModal?: () => void;
};

export const variants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 }
};

export function Input({
  modal,
  reply,
  parent,
  disabled,
  children,
  replyModal,
  parentUrl,
  closeModal
}: InputProps): JSX.Element {
  const [selectedImages, setSelectedImages] = useState<FilesWithId>([]);
  const [imagesPreview, setImagesPreview] = useState<ImagesPreview>([]);
  const [inputValue, setInputValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [visited, setVisited] = useState(false);
  const [embedUrls, setEmbedUrls] = useState<string[]>([]);
  const [embeds, setEmbeds] = useState<ExternalEmbed[]>([]);
  const [ignoredEmbedUrls, setIgnoredEmbedUrls] = useState<string[]>([]);

  const { user, isAdmin } = useAuth();
  const { name, username, photoURL } = user as User;

  const inputRef = useRef<HTMLTextAreaElement>(null);

  const previewCount = imagesPreview.length;
  const isUploadingImages = !!previewCount;

  useEffect(
    () => {
      if (modal) inputRef.current?.focus();
      return cleanImage;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const sendTweet = async (): Promise<void> => {
    inputRef.current?.blur();

    setLoading(true);

    if (!inputValue && selectedImages.length === 0) return;

    const isReplying = reply ?? replyModal;

    const userId = user?.id as string;

    if (isReplying && !parent) return;

    const uploadedLinks: string[] = [];

    // Sequentially upload files
    for (let i = 0; i < selectedImages.length; i++) {
      const link = await uploadToImgur(selectedImages[i]);

      if (!link) {
        toast.error(
          () => <span className='flex gap-2'>Failed to upload image</span>,
          { duration: 6000 }
        );
        setLoading(false);
        return;
      }

      uploadedLinks.push(link);
    }

    const castMessage = await createCastMessage({
      text: inputValue.trim(),
      fid: parseInt(userId),
      embeds: [...uploadedLinks.map((link) => ({ url: link })), ...embeds],
      parentCastHash: isReplying && parent ? parent.id : undefined,
      parentCastFid: isReplying && parent ? parseInt(parent.userId) : undefined,
      parentUrl
    });

    if (castMessage) {
      const res = await submitHubMessage(castMessage);
      const message = Message.fromJSON(res);

      await sleep(500);

      if (!modal && !replyModal) {
        discardTweet();
        setLoading(false);
      }

      if (closeModal) closeModal();

      const tweetId = Buffer.from(message.hash).toString('hex');

      toast.success(
        () => (
          <span className='flex gap-2'>
            Your post was sent
            <Link href={`/tweet/${tweetId}`}>
              <a className='custom-underline font-bold'>View</a>
            </Link>
          </span>
        ),
        { duration: 6000 }
      );
    } else {
      toast.error(
        () => <span className='flex gap-2'>Failed to create post</span>,
        { duration: 6000 }
      );
    }
  };

  const handleImageUpload = (
    e: ChangeEvent<HTMLInputElement> | ClipboardEvent<HTMLTextAreaElement>
  ): void => {
    const isClipboardEvent = 'clipboardData' in e;

    if (isClipboardEvent) {
      const isPastingText = e.clipboardData.getData('text');
      if (isPastingText) return;
    }

    const files = isClipboardEvent ? e.clipboardData.files : e.target.files;

    const imagesData = getImagesData(files, previewCount);

    if (!imagesData) {
      toast.error('Please choose a GIF or photo up to 4');
      return;
    }

    const { imagesPreviewData, selectedImagesData } = imagesData;

    setImagesPreview([...imagesPreview, ...imagesPreviewData]);
    setSelectedImages([...selectedImages, ...selectedImagesData]);

    inputRef.current?.focus();
  };

  const removeImage = (targetId: string) => (): void => {
    setSelectedImages(selectedImages.filter(({ id }) => id !== targetId));
    setImagesPreview(imagesPreview.filter(({ id }) => id !== targetId));

    const { src } = imagesPreview.find(
      ({ id }) => id === targetId
    ) as ImageData;

    URL.revokeObjectURL(src);
  };

  const cleanImage = (): void => {
    imagesPreview.forEach(({ src }) => URL.revokeObjectURL(src));

    setSelectedImages([]);
    setImagesPreview([]);
  };

  const discardTweet = (): void => {
    setInputValue('');
    setVisited(false);
    cleanImage();

    inputRef.current?.blur();
  };

  const handleEmbedsChange = (value: string) => {
    if (value) {
      const urls = getHttpsUrls(value).filter(
        (url) => !ignoredEmbedUrls.includes(url)
      );
      console.log(urls);
      setEmbedUrls(urls.slice(0, 2));
    }
  };

  const handleChangeDebounced = useCallback(
    debounce((e) => handleEmbedsChange(e.target.value), 1500),
    []
  );

  const handleChange = ({
    target: { value }
  }: ChangeEvent<HTMLTextAreaElement>): void => {
    setInputValue(value);
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    void sendTweet();
  };

  const handleFocus = (): void => setVisited(!loading);

  const formId = useId();

  const inputLimit = isAdmin ? 560 : 280;

  const inputLength = inputValue.length;
  const isValidInput = !!inputValue.trim().length;
  const isCharLimitExceeded = inputLength > inputLimit;

  const isValidTweet =
    !isCharLimitExceeded && (isValidInput || isUploadingImages);

  const { data: newEmbeds, isValidating } = useSWR(
    embedUrls.length > 0 ? `/api/embeds?urls=${embedUrls.join(',')}` : null,
    fetchJSON<(ExternalEmbed | null)[]>,
    {}
  );

  useEffect(() => {
    setEmbeds((prevEmbeds) => {
      if (newEmbeds) {
        return newEmbeds.filter((embed) => embed !== null) as ExternalEmbed[];
      } else {
        return prevEmbeds;
      }
    });
  }, [newEmbeds]);

  useEffect(() => {
    handleEmbedsChange(inputValue);
  }, [ignoredEmbedUrls]);

  return (
    <form
      className={cn('flex flex-col', {
        '-mx-4': reply,
        'gap-2': replyModal,
        'cursor-not-allowed': disabled
      })}
      onSubmit={handleSubmit}
    >
      {loading && (
        <motion.i className='h-1 animate-pulse bg-main-accent' {...variants} />
      )}
      {children}
      {reply && visited && (
        <motion.p
          className='-mb-2 ml-[75px] mt-2 text-light-secondary dark:text-dark-secondary'
          {...fromTop}
        >
          Replying to{' '}
          <Link href={`/user/${parent?.username as string}`}>
            <a className='custom-underline text-main-accent'>
              {parent?.username as string}
            </a>
          </Link>
        </motion.p>
      )}
      <label
        className={cn(
          'hover-animation grid w-full grid-cols-[auto,1fr] gap-3 px-4 py-3',
          reply
            ? 'pb-1 pt-3'
            : replyModal
            ? 'pt-0'
            : 'border-b-2 border-light-border dark:border-dark-border',
          (disabled || loading) && 'pointer-events-none opacity-50'
        )}
        htmlFor={formId}
      >
        <UserAvatar src={photoURL} alt={name} username={username} />
        <div className='flex w-full flex-col gap-4'>
          <InputForm
            modal={modal}
            reply={reply}
            formId={formId}
            visited={visited}
            loading={loading}
            inputRef={inputRef}
            replyModal={replyModal}
            inputValue={inputValue}
            isValidTweet={isValidTweet}
            isUploadingImages={isUploadingImages}
            sendTweet={sendTweet}
            handleFocus={handleFocus}
            discardTweet={discardTweet}
            handleChange={(e) => {
              handleChangeDebounced(e);
              handleChange(e);
            }}
            handleImageUpload={handleImageUpload}
          >
            {isUploadingImages && (
              <ImagePreview
                imagesPreview={imagesPreview}
                previewCount={previewCount}
                removeImage={!loading ? removeImage : undefined}
              />
            )}
            {embeds?.map(
              (embed) =>
                embed &&
                !ignoredEmbedUrls.includes(embed.url) && (
                  <div key={embed.url} className='flex items-center gap-2'>
                    <button
                      className='text-light-secondary dark:text-dark-secondary'
                      onClick={() => {
                        setIgnoredEmbedUrls([...ignoredEmbedUrls, embed.url]);
                      }}
                    >
                      x
                    </button>
                    <TweetEmbed {...embed} key={embed.url} />
                  </div>
                )
            )}
          </InputForm>

          <AnimatePresence initial={false}>
            {(reply ? reply && visited && !loading : !loading) && (
              <InputOptions
                reply={reply}
                modal={modal}
                inputLimit={inputLimit}
                inputLength={inputLength}
                isValidTweet={isValidTweet}
                isCharLimitExceeded={isCharLimitExceeded}
                handleImageUpload={handleImageUpload}
              />
            )}
          </AnimatePresence>
        </div>
      </label>
    </form>
  );
}
